import assert from "node:assert/strict";
import test from "node:test";

import {
  ADVANCE_PROJECT_HEAD_SQL,
  INSERT_REVISION_AT_HEAD_SQL,
  prepareRevisionAdvanceBatch,
  revisionAdvanceCommitted,
} from "../shared/project-store.mjs";

const revision = {
  projectId: "11111111-1111-4111-8111-111111111111",
  id: "33333333-3333-4333-8333-333333333333",
  parentRevisionId: "22222222-2222-4222-8222-222222222222",
  sourceAssetId: "44444444-4444-4444-8444-444444444444",
  schemaVersion: 1,
  documentR2Key: "projects/p/revisions/r/document-v1.json",
  documentHash: "a".repeat(64),
  captionStatus: "ready",
  captionLanguage: "as-IN",
  changeSummary: "Corrected line two",
  createdBy: "editor",
  createdAt: "2026-08-10T12:00:00.000Z",
};

function recordingDatabase() {
  const prepared = [];
  return {
    prepared,
    prepare(sql) {
      const statement = {
        sql,
        parameters: null,
        bind(...parameters) {
          statement.parameters = parameters;
          return statement;
        },
      };
      prepared.push(statement);
      return statement;
    },
  };
}

test("prepares one atomic optimistic revision batch with stable bindings", () => {
  const database = recordingDatabase();
  const statements = prepareRevisionAdvanceBatch(database, revision);

  assert.equal(statements.length, 2);
  assert.equal(statements[0].sql, INSERT_REVISION_AT_HEAD_SQL);
  assert.deepEqual(statements[0].parameters, [
    revision.projectId,
    revision.id,
    revision.parentRevisionId,
    revision.sourceAssetId,
    revision.schemaVersion,
    revision.documentR2Key,
    revision.documentHash,
    revision.captionStatus,
    revision.captionLanguage,
    revision.changeSummary,
    revision.createdBy,
    revision.createdAt,
  ]);
  assert.equal(statements[1].sql, ADVANCE_PROJECT_HEAD_SQL);
  assert.deepEqual(statements[1].parameters, [
    revision.projectId,
    revision.id,
    revision.parentRevisionId,
    revision.createdAt,
  ]);
  assert.match(INSERT_REVISION_AT_HEAD_SQL, /head_revision_id IS NULL/);
  assert.match(INSERT_REVISION_AT_HEAD_SQL, /head_revision_id = \?3/);
  assert.match(ADVANCE_PROJECT_HEAD_SQL, /EXISTS[\s\S]*project_revisions/);
});

test("accepts the revision only when both conditional writes commit", () => {
  assert.equal(
    revisionAdvanceCommitted([
      { meta: { changes: 1 } },
      { meta: { changes: 1 } },
    ]),
    true,
  );
  assert.equal(
    revisionAdvanceCommitted([
      { meta: { changes: 0 } },
      { meta: { changes: 0 } },
    ]),
    false,
  );
  assert.equal(
    revisionAdvanceCommitted([
      { meta: { changes: 1 } },
      { meta: { changes: 0 } },
    ]),
    false,
  );
});
