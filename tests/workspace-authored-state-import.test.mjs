import assert from 'node:assert/strict';
import {copyFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {buildBaseWorkspace} from '../scripts/preview-artifacts.mjs';
import {exportWorkspaceAuthoredState,importWorkspaceAuthoredState} from '../src/server/generated-site/workspace-authored-state.ts';
const businessTables = ["ap_vera_services", "ap_vera_calendly_mappings"];
function adapter(db) {
  return {prepare(sql) {let values=[];return {bind(...next){values=next;return this;},execute(){return {results:db.prepare(sql).all(...values)};}};},
    async batch(statements) {db.exec('BEGIN');try {const results=statements.map(statement=>statement.execute());db.exec('COMMIT');return results;}catch(error){db.exec('ROLLBACK');throw error;}}};
}
async function fixture(run) {
  const directory=mkdtempSync(join(tmpdir(),'authored-import-regression-'));let source,target;
  try {
    const sourcePath=join(directory,'source.sqlite'),targetPath=join(directory,'target.sqlite');
    const proof=await buildBaseWorkspace(sourcePath,{templateCommitSha:'a'.repeat(40)});copyFileSync(sourcePath,targetPath);
    source=new DatabaseSync(sourcePath);target=new DatabaseSync(targetPath);
    for(const db of [source,target]) db.exec('PRAGMA foreign_keys=ON');
    for(const table of businessTables) {
      assert.ok(source.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n>0,`nonempty declared ${table}`);
      source.exec(`UPDATE ${table} SET active=1-active`);
    }
    assert.ok(source.prepare('SELECT COUNT(*) n FROM ap_email_events').get().n>0);
    source.exec('UPDATE ap_email_events SET enabled=1-enabled');
    target.prepare('INSERT INTO ap_business_settings(key,value_json,updated_at) VALUES (?,?,?)').run('unrelated_import_fixture','{"preserved":true}','2026-01-01T00:00:00Z');
    const options=db=>({env:{DB:adapter(db)},identity:{templateCommitSha:'a'.repeat(40),migrationDigest:proof.migrationDigest},blobs:{verify:async()=>true}});
    const envelope=await exportWorkspaceAuthoredState(options(source));
    await run({target,envelope,options});
  } finally {source?.close();target?.close();rmSync(directory,{recursive:true,force:true});}
}
test('restores edited declared business and email resources into a nonempty native SQLite base',async()=>{
  await fixture(async({target,envelope,options})=>{
    assert.equal((await importWorkspaceAuthoredState({...options(target),envelope})).idempotent,false);
    assert.deepEqual((await exportWorkspaceAuthoredState(options(target))).domains,envelope.domains);
    assert.deepEqual(target.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(target.prepare("SELECT value_json FROM ap_business_settings WHERE key='unrelated_import_fixture'").get().value_json,'{"preserved":true}');
    assert.equal((await importWorkspaceAuthoredState({...options(target),envelope})).idempotent,true);
  });
});
test('business insert failure rolls back every authored domain and import metadata',async()=>{
  await fixture(async({target,envelope,options})=>{
    const before=await exportWorkspaceAuthoredState(options(target));
    const state=target.prepare('SELECT * FROM ap_workspace_authored_state').all();
    target.exec(`CREATE TRIGGER fail_business_import BEFORE INSERT ON ${businessTables.at(-1)} BEGIN SELECT RAISE(ABORT,'forced business import failure'); END`);
    await assert.rejects(importWorkspaceAuthoredState({...options(target),envelope}),/forced business import failure/);
    assert.deepEqual((await exportWorkspaceAuthoredState(options(target))).domains,before.domains);
    assert.deepEqual(target.prepare('SELECT * FROM ap_workspace_authored_state').all(),state);
    assert.deepEqual(target.prepare('PRAGMA foreign_key_check').all(),[]);
  });
});
