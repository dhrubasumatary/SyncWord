"""GPU forced alignment for SyncWord.

Deploy with:
    modal deploy modal_app/syncword_aligner.py

The HTTP endpoint accepts a mono 16 kHz WAV plus Sarvam phrase captions and
returns the same captions with MMS forced-alignment word timings.
"""

import json
import importlib.metadata
import math
import tempfile
import unicodedata
import wave
from pathlib import Path
from typing import Any

import modal


MODEL_CARD = "MMS_FA"
REVISION = "mms-fa-speech-windows-v13"
MAX_CAPTION_WINDOW_SECONDS = 13.0
ALIGNMENT_PADDING_SECONDS = 1.2
MAX_CONTINUOUS_GROUP_SECONDS = 13.0
MODEL_CACHE_PATH = Path("/root/.cache/torch")
MODEL_CACHE = modal.Volume.from_name(
    "syncword-mms-fa-cache",
    create_if_missing=True,
)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libsndfile1")
    .pip_install(
        "fastapi[standard]==0.116.1",
        "numpy==1.26.4",
        "torch==2.8.0",
        "torchaudio==2.8.0",
        "python-multipart==0.0.20",
        "uroman==1.3.1.1",
    )
)

app = modal.App("syncword-aligner")
_alignment_runtime: tuple[Any, Any, Any, Any] | None = None
UROMAN_LANGUAGE_CODES = {
    "as": "asm",
    "asm": "asm",
    "as-in": "asm",
    "brx": "brx",
    "brx-in": "brx",
}


def _get_alignment_runtime() -> tuple[Any, Any, Any, Any]:
    global _alignment_runtime
    if _alignment_runtime is None:
        import torch
        import torchaudio
        import uroman as ur

        bundle = torchaudio.pipelines.MMS_FA
        model = bundle.get_model(with_star=True).to(
            device="cuda",
            dtype=torch.float32,
        )
        model.eval()
        _alignment_runtime = (
            model,
            bundle.get_tokenizer(),
            bundle.get_aligner(),
            ur.Uroman(),
        )
    return _alignment_runtime


def _is_acoustic_character(character: str) -> bool:
    category = unicodedata.category(character)
    return category[0] in {"L", "M", "N"}


def _uroman_language(caption: dict[str, Any], text: str) -> str | None:
    configured = UROMAN_LANGUAGE_CODES.get(
        str(caption.get("language", "")).strip().lower()
    )
    if configured:
        return configured
    if any("\u0980" <= character <= "\u09ff" for character in text):
        return "asm"
    if any("\u0900" <= character <= "\u097f" for character in text):
        return "brx"
    return None


def _normalize_alignment_word(
    word: str,
    romanizer: Any,
    language_code: str | None,
) -> str:
    kwargs = {"lcode": language_code} if language_code else {}
    romanized = romanizer.romanize_string(word, **kwargs)
    romanized = unicodedata.normalize("NFKD", romanized)
    return "".join(
        character.lower()
        for character in romanized
        if character.isascii()
        and (character.isalpha() or character == "'")
    )


def _align_word_spans(
    emission: Any,
    tokenizer: Any,
    aligner: Any,
    normalized_words: list[str],
    wildcard_before: set[int] | None = None,
) -> list[Any]:
    alignment_words: list[str] = []
    display_span_indexes: list[int] = []
    recovery_boundaries = wildcard_before or set()
    for index, normalized_word in enumerate(normalized_words):
        if index in recovery_boundaries:
            alignment_words.append("*")
        display_span_indexes.append(len(alignment_words))
        alignment_words.append(normalized_word)

    all_token_spans = aligner(
        emission,
        tokenizer(alignment_words),
    )
    return [
        all_token_spans[index]
        for index in display_span_indexes
    ]


def _suspicious_word_boundaries(
    normalized_words: list[str],
    token_spans: list[Any],
    seconds_per_frame: float,
) -> set[int]:
    boundaries: set[int] = set()
    for index, (normalized_word, spans) in enumerate(
        zip(normalized_words, token_spans)
    ):
        character_count = max(
            1,
            len(normalized_word.replace("*", "")),
        )
        duration = (
            float(spans[-1].end) - float(spans[0].start)
        ) * seconds_per_frame
        maximum_duration = max(
            1.2,
            character_count * 0.18 + 0.45,
        )
        if duration > maximum_duration:
            boundaries.add(index)
    return boundaries


def _edit_similarity(left: str, right: str) -> float:
    if left == right:
        return 1.0
    if not left or not right:
        return 0.0

    previous = list(range(len(right) + 1))
    for left_index, left_character in enumerate(left, start=1):
        current = [left_index]
        for right_index, right_character in enumerate(right, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[right_index] + 1,
                    previous[right_index - 1]
                    + (left_character != right_character),
                )
            )
        previous = current
    distance = previous[-1]
    return max(0.0, 1.0 - distance / max(len(left), len(right)))


def _surface_words(
    captions: list[dict[str, Any]],
    romanizer: Any,
) -> list[tuple[dict[str, Any], str]]:
    output: list[tuple[dict[str, Any], str]] = []
    for caption in captions:
        language_code = _uroman_language(
            caption,
            str(caption.get("text", "")),
        )
        if isinstance(caption.get("words"), list):
            words = caption["words"]
        else:
            words = [
                {"text": word}
                for word in str(caption.get("text", "")).split()
                if word
            ]
        for word in words:
            text = str(word.get("text", "")).strip()
            if not text:
                continue
            normalized = _normalize_alignment_word(
                text,
                romanizer,
                language_code,
            )
            if normalized:
                output.append((word, normalized))
    return output


def _apply_display_surfaces(
    aligned_captions: list[dict[str, Any]],
    display_captions: list[dict[str, Any]],
    romanizer: Any,
) -> int:
    acoustic_words = _surface_words(aligned_captions, romanizer)
    display_words = _surface_words(display_captions, romanizer)
    acoustic_count = len(acoustic_words)
    display_count = len(display_words)
    if not acoustic_count or not display_count:
        return 0

    acoustic_gap = -0.35
    display_gap = -0.55
    scores = [
        [0.0] * (display_count + 1)
        for _ in range(acoustic_count + 1)
    ]
    choices = [
        [""] * (display_count + 1)
        for _ in range(acoustic_count + 1)
    ]
    for acoustic_index in range(1, acoustic_count + 1):
        scores[acoustic_index][0] = acoustic_index * acoustic_gap
        choices[acoustic_index][0] = "acoustic"
    for display_index in range(1, display_count + 1):
        scores[0][display_index] = display_index * display_gap
        choices[0][display_index] = "display"

    for acoustic_index in range(1, acoustic_count + 1):
        acoustic_normalized = acoustic_words[acoustic_index - 1][1]
        for display_index in range(1, display_count + 1):
            display_normalized = display_words[display_index - 1][1]
            similarity = _edit_similarity(
                acoustic_normalized,
                display_normalized,
            )
            candidates = (
                (
                    scores[acoustic_index - 1][display_index - 1]
                    + similarity * 2.4
                    - 0.8,
                    "match",
                ),
                (
                    scores[acoustic_index - 1][display_index]
                    + acoustic_gap,
                    "acoustic",
                ),
                (
                    scores[acoustic_index][display_index - 1]
                    + display_gap,
                    "display",
                ),
            )
            best_score, best_choice = max(
                candidates,
                key=lambda candidate: candidate[0],
            )
            scores[acoustic_index][display_index] = best_score
            choices[acoustic_index][display_index] = best_choice

    replacements = 0
    acoustic_index = acoustic_count
    display_index = display_count
    while acoustic_index or display_index:
        choice = choices[acoustic_index][display_index]
        if choice == "match":
            acoustic_word, acoustic_normalized = acoustic_words[
                acoustic_index - 1
            ]
            display_word, display_normalized = display_words[
                display_index - 1
            ]
            if (
                _edit_similarity(
                    acoustic_normalized,
                    display_normalized,
                )
                >= 0.52
            ):
                display_text = str(display_word["text"]).strip()
                if display_text and acoustic_word["text"] != display_text:
                    acoustic_word["text"] = display_text
                    replacements += 1
            acoustic_index -= 1
            display_index -= 1
        elif choice == "acoustic":
            acoustic_index -= 1
        elif choice == "display":
            display_index -= 1
        else:
            break

    for caption in aligned_captions:
        words = caption.get("words")
        if isinstance(words, list) and words:
            caption["text"] = " ".join(
                str(word["text"]) for word in words
            )
    return replacements


def _alignment_text(text: str) -> tuple[str, list[str], list[int | None]]:
    """Return model text, display words, and a word index for every character."""

    display_words = [word for word in text.strip().split() if word]
    acoustic_words: list[str] = []
    acoustic_to_display: list[int] = []

    for display_index, word in enumerate(display_words):
        acoustic_word = "".join(
            character
            for character in word
            if _is_acoustic_character(character)
        )
        if acoustic_word:
            acoustic_words.append(acoustic_word)
            acoustic_to_display.append(display_index)

    model_text = " ".join(acoustic_words)
    character_words: list[int | None] = []
    acoustic_index = 0
    for character in model_text:
        if character.isspace():
            character_words.append(None)
        else:
            character_words.append(acoustic_to_display[acoustic_index])
        if character.isspace():
            acoustic_index += 1

    return model_text, display_words, character_words


def _load_pcm16_wav(path: Path) -> tuple[Any, int]:
    import numpy as np

    with wave.open(str(path), "rb") as source:
        if source.getnchannels() != 1:
            raise ValueError("Alignment audio must be mono.")
        if source.getsampwidth() != 2:
            raise ValueError("Alignment audio must use signed 16-bit PCM.")
        sample_rate = source.getframerate()
        samples = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2")
    return samples.astype(np.float32) / 32768.0, sample_rate


def _ctc_viterbi(
    log_probs: Any,
    target_ids: Any,
    *,
    blank_id: int = 0,
) -> tuple[list[list[int]], list[float]]:
    """Find the highest-probability CTC path for a known target sequence."""

    import torch

    frame_count = int(log_probs.shape[0])
    token_count = int(target_ids.numel())
    if token_count == 0:
        return [], []
    if frame_count < token_count:
        raise ValueError("The phrase has fewer acoustic frames than characters.")

    expanded = torch.full(
        (token_count * 2 + 1,),
        blank_id,
        dtype=torch.long,
        device=log_probs.device,
    )
    expanded[1::2] = target_ids
    state_count = int(expanded.numel())
    negative_infinity = torch.tensor(
        float("-inf"),
        dtype=log_probs.dtype,
        device=log_probs.device,
    )

    previous = torch.full(
        (state_count,),
        negative_infinity,
        dtype=log_probs.dtype,
        device=log_probs.device,
    )
    previous[0] = log_probs[0, blank_id]
    if state_count > 1:
        previous[1] = log_probs[0, expanded[1]]

    backpointers = torch.zeros(
        (frame_count, state_count),
        dtype=torch.int8,
        device="cpu",
    )

    for frame in range(1, frame_count):
        stay = previous
        advance = torch.cat(
            (negative_infinity.expand(1), previous[:-1]),
        )
        skip = torch.cat(
            (negative_infinity.expand(2), previous[:-2]),
        )
        can_skip = torch.zeros(
            state_count,
            dtype=torch.bool,
            device=log_probs.device,
        )
        if state_count > 2:
            state_indices = torch.arange(
                2,
                state_count,
                device=log_probs.device,
            )
            can_skip[2:] = (
                (state_indices % 2 == 1)
                & (expanded[2:] != expanded[:-2])
            )
        skip = torch.where(can_skip, skip, negative_infinity)

        candidates = torch.stack((stay, advance, skip), dim=0)
        best_scores, choices = torch.max(candidates, dim=0)
        current = best_scores + log_probs[frame, expanded]
        backpointers[frame] = choices.to(device="cpu", dtype=torch.int8)
        previous = current

    final_candidates = [state_count - 1]
    if state_count > 1:
        final_candidates.append(state_count - 2)
    final_state = max(
        final_candidates,
        key=lambda state: float(previous[state].item()),
    )
    if not math.isfinite(float(previous[final_state].item())):
        raise ValueError("The transcript cannot be aligned to this phrase.")

    states = [0] * frame_count
    state = final_state
    for frame in range(frame_count - 1, -1, -1):
        states[frame] = state
        if frame:
            state -= int(backpointers[frame, state].item())

    token_frames: list[list[int]] = [[] for _ in range(token_count)]
    token_confidence: list[list[float]] = [[] for _ in range(token_count)]
    for frame, aligned_state in enumerate(states):
        if aligned_state % 2 == 0:
            continue
        token_index = (aligned_state - 1) // 2
        token_frames[token_index].append(frame)
        token_id = int(target_ids[token_index].item())
        token_confidence[token_index].append(
            float(log_probs[frame, token_id].exp().item()),
        )

    if any(not frames for frames in token_frames):
        raise ValueError("At least one transcript character was not aligned.")
    confidences = [
        sum(values) / len(values) if values else 0.0
        for values in token_confidence
    ]
    return token_frames, confidences


def _fallback_words(
    caption: dict[str, Any],
    display_words: list[str],
) -> list[dict[str, Any]]:
    start = float(caption["start"])
    end = float(caption["end"])
    weights = [
        max(1.0, len("".join(ch for ch in word if _is_acoustic_character(ch))) ** 0.72)
        for word in display_words
    ]
    total_weight = sum(weights) or 1.0
    cursor = start
    words: list[dict[str, Any]] = []
    for index, (word, weight) in enumerate(zip(display_words, weights)):
        word_end = (
            end
            if index == len(display_words) - 1
            else cursor + (end - start) * weight / total_weight
        )
        words.append(
            {
                "id": f"{caption.get('id', 'caption')}-word-{index + 1}",
                "text": word,
                "start": round(cursor, 3),
                "end": round(word_end, 3),
                "confidence": 0.25,
                "source": "grapheme-prior",
            }
        )
        cursor = word_end
    return words


def _find_low_energy_split(
    waveform: Any,
    sample_rate: int,
    start: float,
    end: float,
) -> float:
    import numpy as np

    duration = end - start
    center = (start + end) / 2
    edge_guard = min(8.0, max(3.0, duration * 0.22))
    search_start = start + edge_guard
    search_end = end - edge_guard
    if search_end <= search_start:
        return center

    half_window = max(1, int(round(0.12 * sample_rate)))
    step = max(1, int(round(0.04 * sample_rate)))
    first_sample = max(half_window, int(round(search_start * sample_rate)))
    last_sample = min(
        len(waveform) - half_window,
        int(round(search_end * sample_rate)),
    )
    if last_sample <= first_sample:
        return center

    candidates: list[tuple[float, float]] = []
    for sample in range(first_sample, last_sample + 1, step):
        window = waveform[sample - half_window : sample + half_window]
        energy = float(np.sqrt(np.mean(np.square(window)) + 1e-12))
        candidates.append((sample / sample_rate, energy))
    if not candidates:
        return center

    median_energy = float(
        np.median([energy for _, energy in candidates])
    ) + 1e-8
    search_radius = max(0.001, (search_end - search_start) / 2)
    split_time, _ = min(
        candidates,
        key=lambda candidate: (
            candidate[1] / median_energy
            + 0.22 * abs(candidate[0] - center) / search_radius
        ),
    )
    return split_time


def _word_split_index(
    display_words: list[str],
    target_ratio: float,
) -> int:
    weights = [
        max(
            1.0,
            len(
                "".join(
                    character
                    for character in word
                    if _is_acoustic_character(character)
                )
            )
            ** 0.72,
        )
        for word in display_words
    ]
    total_weight = sum(weights) or float(len(display_words))
    running_weight = 0.0
    candidates: list[tuple[float, int]] = []
    for index in range(1, len(display_words)):
        running_weight += weights[index - 1]
        ratio_error = abs(running_weight / total_weight - target_ratio)
        punctuation_bonus = (
            0.08
            if display_words[index - 1].rstrip().endswith(
                (".", "!", "?", "।", "॥", "…", ",", ";", ":")
            )
            else 0.0
        )
        candidates.append((ratio_error - punctuation_bonus, index))
    return min(candidates)[1]


def _split_long_caption(
    waveform: Any,
    sample_rate: int,
    caption: dict[str, Any],
    split_index: int | None = None,
) -> tuple[dict[str, Any], dict[str, Any], float, int] | None:
    start = max(0.0, float(caption["start"]))
    end = min(len(waveform) / sample_rate, float(caption["end"]))
    display_words = [
        word
        for word in str(caption.get("text", "")).strip().split()
        if word
    ]
    if (
        end - start <= MAX_CAPTION_WINDOW_SECONDS
        or len(display_words) < 4
    ):
        return None

    split_time = _find_low_energy_split(
        waveform,
        sample_rate,
        start,
        end,
    )
    target_ratio = max(
        0.1,
        min(0.9, (split_time - start) / max(0.001, end - start)),
    )
    resolved_split_index = (
        split_index
        if split_index is not None
        else _word_split_index(display_words, target_ratio)
    )
    resolved_split_index = max(
        1,
        min(len(display_words) - 1, resolved_split_index),
    )
    caption_id = str(caption.get("id", "caption"))
    left = {
        **caption,
        "id": f"{caption_id}-window-a",
        "start": start,
        "end": split_time,
        "text": " ".join(display_words[:resolved_split_index]),
        "_alignment_padding_after": 0.24,
    }
    right = {
        **caption,
        "id": f"{caption_id}-window-b",
        "start": split_time,
        "end": end,
        "text": " ".join(display_words[resolved_split_index:]),
        "_alignment_padding_before": 0.24,
    }
    return left, right, split_time, resolved_split_index


def _trim_recovery_word_end(
    waveform: Any,
    sample_rate: int,
    word_start: float,
    proposed_end: float,
    text: str,
) -> float:
    import numpy as np

    acoustic_characters = sum(
        1 for character in text if _is_acoustic_character(character)
    )
    maximum_duration = min(
        1.4,
        max(0.58, 0.34 + acoustic_characters * 0.12),
    )
    capped_end = min(proposed_end, word_start + maximum_duration)
    if capped_end - word_start <= 0.22:
        return capped_end

    frame_samples = max(1, int(round(0.06 * sample_rate)))
    step_samples = max(1, int(round(0.02 * sample_rate)))
    first_sample = max(0, int(round(word_start * sample_rate)))
    last_sample = min(
        len(waveform) - frame_samples,
        int(round(capped_end * sample_rate)),
    )
    if last_sample <= first_sample:
        return capped_end

    energies: list[tuple[float, float]] = []
    for sample in range(first_sample, last_sample + 1, step_samples):
        frame = waveform[sample : sample + frame_samples]
        energy = float(np.sqrt(np.mean(np.square(frame)) + 1e-12))
        energies.append((sample / sample_rate, energy))
    if len(energies) < 4:
        return capped_end

    peak_index = max(
        range(len(energies)),
        key=lambda index: energies[index][1],
    )
    peak_energy = energies[peak_index][1]
    noise_floor = float(
        np.percentile([energy for _, energy in energies], 20)
    )
    silence_threshold = max(
        noise_floor * 1.45,
        peak_energy * 0.2,
    )
    minimum_end = word_start + 0.22
    for index in range(peak_index + 1, len(energies) - 2):
        if energies[index][0] < minimum_end:
            continue
        if all(
            energies[candidate][1] <= silence_threshold
            for candidate in range(index, index + 3)
        ):
            return min(
                capped_end,
                max(word_start + 0.12, energies[index][0] + 0.06),
            )
    return capped_end


def _align_caption_window(
    runtime: tuple[Any, Any, Any, Any],
    waveform: Any,
    sample_rate: int,
    caption: dict[str, Any],
) -> tuple[list[dict[str, Any]], int]:
    import numpy as np
    import torch

    _, display_words, _ = _alignment_text(
        str(caption.get("text", "")),
    )
    if not display_words:
        return [], 0

    padding_before = float(
        caption.get(
            "_alignment_padding_before",
            ALIGNMENT_PADDING_SECONDS,
        )
    )
    padding_after = float(
        caption.get(
            "_alignment_padding_after",
            ALIGNMENT_PADDING_SECONDS,
        )
    )
    phrase_start = max(
        0.0,
        float(caption["start"]) - padding_before,
    )
    phrase_end = min(
        len(waveform) / sample_rate,
        float(caption["end"]) + padding_after,
    )
    if phrase_end <= phrase_start:
        return _fallback_words(caption, display_words), 0
    if phrase_end - phrase_start > 39.5:
        return _fallback_words(caption, display_words), 0

    start_sample = max(0, int(round(phrase_start * sample_rate)))
    end_sample = min(len(waveform), int(round(phrase_end * sample_rate)))
    segment = np.ascontiguousarray(waveform[start_sample:end_sample])
    if segment.size < 320:
        return _fallback_words(caption, display_words), 0

    model, tokenizer, aligner, romanizer = runtime
    language_code = _uroman_language(
        caption,
        " ".join(display_words),
    )
    normalized_words = [
        _normalize_alignment_word(
            display_word,
            romanizer,
            language_code,
        )
        or "*"
        for display_word in display_words
    ]

    with torch.inference_mode():
        emission, _ = model(
            torch.from_numpy(segment)
            .unsqueeze(0)
            .to(device="cuda", dtype=torch.float32),
        )

    try:
        token_spans = _align_word_spans(
            emission[0],
            tokenizer,
            aligner,
            normalized_words,
        )
    except (RuntimeError, ValueError):
        return _fallback_words(caption, display_words), 0

    if len(token_spans) != len(display_words) or any(
        not spans for spans in token_spans
    ):
        return _fallback_words(caption, display_words), 0

    output_frames = int(emission.shape[1])
    seconds_per_frame = (len(segment) / sample_rate) / output_frames
    recovery_boundaries = _suspicious_word_boundaries(
        normalized_words,
        token_spans,
        seconds_per_frame,
    )
    if recovery_boundaries:
        try:
            recovered_spans = _align_word_spans(
                emission[0],
                tokenizer,
                aligner,
                normalized_words,
                recovery_boundaries,
            )
            if len(recovered_spans) == len(display_words) and all(
                recovered_spans
            ):
                token_spans = recovered_spans
        except (RuntimeError, ValueError):
            recovery_boundaries.clear()

    onsets = [
        phrase_start + float(spans[0].start) * seconds_per_frame
        for spans in token_spans
    ]
    acoustic_ends = [
        phrase_start + float(spans[-1].end) * seconds_per_frame
        for spans in token_spans
    ]
    phrase_end_anchor = max(float(caption["end"]), acoustic_ends[-1])

    words: list[dict[str, Any]] = []
    for index, text in enumerate(display_words):
        word_start = onsets[index]
        next_onset = (
            onsets[index + 1]
            if index + 1 < len(onsets)
            else phrase_end_anchor
        )
        word_end = min(next_onset, acoustic_ends[index] + 0.16)
        word_end = max(word_start + 0.04, word_end)
        spans = token_spans[index]
        span_length = sum(max(1, int(span.end) - int(span.start)) for span in spans)
        confidence = sum(
            float(span.score) * max(1, int(span.end) - int(span.start))
            for span in spans
        ) / max(1, span_length)
        source = (
            "mms-fa-star"
            if (
                normalized_words[index] == "*"
                or index in recovery_boundaries
            )
            else "mms-fa"
        )
        if source == "mms-fa-star":
            word_end = _trim_recovery_word_end(
                waveform,
                sample_rate,
                word_start,
                word_end,
                text,
            )
        words.append(
            {
                "id": f"{caption.get('id', 'caption')}-word-{index + 1}",
                "text": text,
                "start": round(word_start, 3),
                "end": round(word_end, 3),
                "confidence": round(max(0.0, min(1.0, confidence)), 3),
                "source": source,
            }
        )
    return words, len(words)


def _align_caption(
    runtime: tuple[Any, Any, Any, Any],
    waveform: Any,
    sample_rate: int,
    caption: dict[str, Any],
) -> tuple[list[dict[str, Any]], int]:
    split = _split_long_caption(
        waveform,
        sample_rate,
        caption,
    )
    if split is None:
        return _align_caption_window(
            runtime,
            waveform,
            sample_rate,
            caption,
        )

    left, right, split_time, split_index = split
    display_word_count = len(
        str(caption.get("text", "")).strip().split()
    )
    tried_indexes: set[int] = set()
    best: tuple[
        float,
        list[dict[str, Any]],
        int,
    ] | None = None
    for _ in range(8):
        if split_index in tried_indexes:
            break
        tried_indexes.add(split_index)
        candidate_split = _split_long_caption(
            waveform,
            sample_rate,
            caption,
            split_index,
        )
        if candidate_split is None:
            break
        left, right, split_time, split_index = candidate_split
        left_words, left_aligned_count = _align_caption(
            runtime,
            waveform,
            sample_rate,
            left,
        )
        right_words, right_aligned_count = _align_caption(
            runtime,
            waveform,
            sample_rate,
            right,
        )
        words = [*left_words, *right_words]
        aligned_word_count = (
            left_aligned_count + right_aligned_count
        )
        if not left_words or not right_words:
            break

        left_overrun = max(
            0.0,
            float(left_words[-1]["start"]) - split_time,
        )
        right_underrun = max(
            0.0,
            split_time - float(right_words[0]["end"]),
        )
        boundary_overlap = max(
            0.0,
            float(left_words[-1]["end"])
            - float(right_words[0]["start"]),
        )
        average_confidence = sum(
            float(word["confidence"]) for word in words
        ) / max(1, len(words))
        score = (
            aligned_word_count * 10.0
            + average_confidence
            - left_overrun * 8.0
            - right_underrun * 8.0
            - boundary_overlap * 5.0
        )
        print(
            json.dumps(
                {
                    "event": "alignment_window_candidate",
                    "captionId": caption.get("id"),
                    "splitTime": round(split_time, 3),
                    "splitIndex": split_index,
                    "leftOverrun": round(left_overrun, 3),
                    "rightUnderrun": round(right_underrun, 3),
                    "boundaryOverlap": round(boundary_overlap, 3),
                    "alignedWords": aligned_word_count,
                    "score": round(score, 3),
                },
                ensure_ascii=True,
            )
        )
        if best is None or score > best[0]:
            best = (score, words, aligned_word_count)

        if (
            left_overrun <= 0.12
            and right_underrun <= 0.12
            and boundary_overlap <= 0.08
        ):
            break
        if left_overrun > right_underrun and split_index > 1:
            word_shift = max(
                1,
                min(5, math.ceil(left_overrun / 0.45)),
            )
            split_index = max(1, split_index - word_shift)
            continue
        if (
            right_underrun >= left_overrun
            and split_index < display_word_count - 1
        ):
            word_shift = max(
                1,
                min(5, math.ceil(right_underrun / 0.45)),
            )
            split_index = min(
                display_word_count - 1,
                split_index + word_shift,
            )
            continue
        break

    if best is None:
        display_words = [
            word
            for word in str(caption.get("text", "")).split()
            if word
        ]
        return _fallback_words(caption, display_words), 0

    _, words, aligned_word_count = best
    caption_id = str(caption.get("id", "caption"))
    for index, word in enumerate(words):
        word["id"] = f"{caption_id}-word-{index + 1}"
        if index:
            previous = words[index - 1]
            if float(word["start"]) < float(previous["end"]):
                word["start"] = round(
                    float(previous["end"]),
                    3,
                )
                word["end"] = round(
                    max(
                        float(word["start"]) + 0.04,
                        float(word["end"]),
                    ),
                    3,
                )
                word["confidence"] = 0.0
                word["source"] = "speech-window-review"
    return words, aligned_word_count


def _caption_display_words(caption: dict[str, Any]) -> list[str]:
    return [
        word
        for word in str(caption.get("text", "")).strip().split()
        if word
    ]


def _continuous_caption_groups(
    captions: list[dict[str, Any]],
) -> list[list[dict[str, Any]]]:
    groups: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []

    for caption in captions:
        if not _caption_display_words(caption):
            continue
        if not current:
            current = [caption]
            continue

        first = current[0]
        previous = current[-1]
        combined_duration = (
            float(caption["end"]) - float(first["start"])
        )
        gap = float(caption["start"]) - float(previous["end"])
        same_language = _uroman_language(
            first,
            str(first.get("text", "")),
        ) == _uroman_language(
            caption,
            str(caption.get("text", "")),
        )
        first_segment = str(
            first.get("_source_segment_id", "")
        ).strip()
        next_segment = str(
            caption.get("_source_segment_id", "")
        ).strip()
        same_source_segment = (
            not first_segment
            or not next_segment
            or first_segment == next_segment
        )
        if (
            same_language
            and same_source_segment
            and gap <= 2.0
            and combined_duration <= MAX_CONTINUOUS_GROUP_SECONDS
        ):
            current.append(caption)
            continue

        groups.append(current)
        current = [caption]

    if current:
        groups.append(current)
    return groups


def _alignment_group_caption(
    members: list[dict[str, Any]],
    group_index: int,
    group_count: int,
) -> dict[str, Any]:
    first = members[0]
    last = members[-1]
    merged = {
        **first,
        "id": f"continuous-utterance-{group_index + 1}",
        "start": float(first["start"]),
        "end": float(last["end"]),
        "text": " ".join(
            str(member.get("text", "")).strip()
            for member in members
            if str(member.get("text", "")).strip()
        ),
    }
    if group_index > 0:
        merged["_alignment_padding_before"] = 0.24
    if group_index + 1 < group_count:
        merged["_alignment_padding_after"] = 0.24
    return merged


def _restore_caption_members(
    members: list[dict[str, Any]],
    words: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    restored: list[dict[str, Any]] = []
    offset = 0
    for member in members:
        word_count = len(_caption_display_words(member))
        member_words = [
            {
                **word,
                "id": f"{member.get('id', 'caption')}-word-{index + 1}",
            }
            for index, word in enumerate(
                words[offset : offset + word_count]
            )
        ]
        offset += word_count
        restored.append(
            {
                **member,
                "start": (
                    float(member_words[0]["start"])
                    if member_words
                    else float(member["start"])
                ),
                "end": (
                    float(member_words[-1]["end"])
                    if member_words
                    else float(member["end"])
                ),
                "words": member_words,
            }
        )
    return restored


def align_captions(
    wav_path: Path,
    captions: list[dict[str, Any]],
    display_captions: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    waveform, sample_rate = _load_pcm16_wav(wav_path)
    if sample_rate != 16_000:
        raise ValueError("Alignment audio must be sampled at 16 kHz.")

    runtime = _get_alignment_runtime()
    aligned_captions: list[dict[str, Any]] = []
    ctc_words = 0
    total_words = 0
    confidence_sum = 0.0
    language_counts: dict[str, int] = {}
    recovered_words = 0

    for caption in captions:
        language_code = _uroman_language(
            caption,
            str(caption.get("text", "")),
        )
        language_key = language_code or "und"
        language_counts[language_key] = (
            language_counts.get(language_key, 0) + 1
        )

    groups = _continuous_caption_groups(captions)
    for group_index, members in enumerate(groups):
        alignment_caption = _alignment_group_caption(
            members,
            group_index,
            len(groups),
        )
        words, _ = _align_caption(
            runtime,
            waveform,
            sample_rate,
            alignment_caption,
        )
        total_words += len(words)
        ctc_words += sum(
            1
            for word in words
            if word["source"] == "mms-fa"
        )
        confidence_sum += sum(float(word["confidence"]) for word in words)
        recovered_words += sum(
            1
            for word in words
            if word["source"] == "mms-fa-star"
        )
        aligned_captions.extend(
            _restore_caption_members(members, words)
        )

    needs_review = sum(
        1
        for caption in aligned_captions
        for word in caption["words"]
        if (
            float(word["confidence"]) < 0.35
            or word["source"]
            in {
                "mms-fa-star",
                "speech-window-review",
                "grapheme-prior",
            }
        )
    )
    surface_words_replaced = (
        _apply_display_surfaces(
            aligned_captions,
            display_captions,
            runtime[3],
        )
        if display_captions
        else 0
    )
    summary = {
        "method": REVISION,
        "totalWords": total_words,
        "waveformAlignedWords": ctc_words,
        "averageConfidence": round(
            confidence_sum / total_words if total_words else 0.0,
            3,
        ),
        "needsReview": needs_review,
        "stableWords": max(0, total_words - needs_review),
        "estimatedWords": max(0, total_words - ctc_words),
        "alignmentComplete": ctc_words == total_words,
        "recoveredWords": recovered_words,
        "surfaceWordsReplaced": surface_words_replaced,
        "languages": language_counts,
    }
    print(
        json.dumps(
            {
                "event": "alignment_complete",
                "revision": REVISION,
                **summary,
            },
            ensure_ascii=True,
        )
    )
    return {
        "captions": aligned_captions,
        "alignment": summary,
    }


@app.function(
    image=image,
    gpu="T4",
    timeout=20 * 60,
    scaledown_window=5 * 60,
    volumes={MODEL_CACHE_PATH: MODEL_CACHE},
)
@modal.asgi_app()
def alignment_api() -> Any:
    from fastapi import FastAPI, File, Form, HTTPException, UploadFile

    api = FastAPI(title="SyncWord forced alignment", docs_url=None, redoc_url=None)

    @api.get("/health")
    def health() -> dict[str, Any]:
        return {
            "ok": True,
            "service": "syncword-aligner",
            "model": MODEL_CARD,
            "revision": REVISION,
            "torch": importlib.metadata.version("torch"),
            "torchaudio": importlib.metadata.version("torchaudio"),
        }

    @api.post("/v1/align")
    async def align(
        audio: UploadFile = File(...),
        captions: str = Form(...),
        display_captions: str | None = Form(None),
    ) -> dict[str, Any]:
        try:
            parsed_captions = json.loads(captions)
        except json.JSONDecodeError as error:
            raise HTTPException(400, "captions must be valid JSON") from error
        if not isinstance(parsed_captions, list) or not parsed_captions:
            raise HTTPException(400, "captions must be a non-empty array")
        if len(parsed_captions) > 500:
            raise HTTPException(413, "caption limit exceeded")
        parsed_display_captions = None
        if display_captions:
            try:
                parsed_display_captions = json.loads(display_captions)
            except json.JSONDecodeError as error:
                raise HTTPException(
                    400,
                    "display_captions must be valid JSON",
                ) from error
            if (
                not isinstance(parsed_display_captions, list)
                or len(parsed_display_captions) > 500
            ):
                raise HTTPException(
                    400,
                    "display_captions must be an array",
                )

        with tempfile.TemporaryDirectory(prefix="syncword-align-") as directory:
            audio_path = Path(directory) / "audio.wav"
            written = 0
            with audio_path.open("wb") as destination:
                while chunk := await audio.read(1024 * 1024):
                    written += len(chunk)
                    if written > 128 * 1024 * 1024:
                        raise HTTPException(413, "audio limit exceeded")
                    destination.write(chunk)
            try:
                return align_captions(
                    audio_path,
                    parsed_captions,
                    parsed_display_captions,
                )
            except ValueError as error:
                raise HTTPException(422, str(error)) from error

    return api


@app.local_entrypoint()
def main(audio: str, captions: str) -> None:
    """Run a local smoke request against the deployed/ephemeral endpoint."""

    import requests

    caption_payload = Path(captions).read_text(encoding="utf-8")
    endpoint = alignment_api.get_web_url()
    if not endpoint:
        raise RuntimeError("The alignment web endpoint is unavailable.")
    with Path(audio).open("rb") as audio_file:
        response = requests.post(
            f"{endpoint}/v1/align",
            files={"audio": ("audio.wav", audio_file, "audio/wav")},
            data={"captions": caption_payload},
            timeout=20 * 60,
        )
    response.raise_for_status()
    print(json.dumps(response.json(), ensure_ascii=False, indent=2))
