/* Exercise the GitHub backend of store.js against a fake Contents API. */
process.env.GITHUB_TOKEN='fake-token';
process.env.DATA_REPO='someone/homeboard-data';
process.env.DATA_BRANCH='main';
process.env.DATA_DIR='data';

const files = {};            // path -> {content(b64), sha}
const calls = [];
let sha = 0;
let force409Once = false;

global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const path = decodeURIComponent(u.pathname.replace('/repos/someone/homeboard-data/contents/',''));
  calls.push(`${opts.method||'GET'} ${path}`);
  if ((opts.method||'GET') === 'GET') {
    if (!files[path]) return { ok:false, status:404, json:async()=>({}), text:async()=>'' };
    return { ok:true, status:200, json:async()=>({ content:files[path].content, sha:files[path].sha }) };
  }
  const body = JSON.parse(opts.body);
  if (force409Once) { force409Once = false; return { ok:false, status:409, json:async()=>({}), text:async()=>'conflict' }; }
  if (files[path] && files[path].sha !== body.sha)
    return { ok:false, status:409, json:async()=>({}), text:async()=>'sha mismatch' };
  files[path] = { content: body.content, sha: `sha${++sha}` };
  return { ok:true, status:200, json:async()=>({ content:{ sha: files[path].sha } }) };
};

const store = require('../server/store.js');
let pass=0, fail=0;
const check=(l,c,d)=>c?(pass++,console.log(`  \x1b[32m✓\x1b[0m ${l}`)):(fail++,console.log(`  \x1b[31m✗\x1b[0m ${l} — ${d||''}`));
const decode = (p) => JSON.parse(Buffer.from(files[p].content,'base64').toString());

(async () => {
  console.log('\nGitHub storage backend\n');
  const info = await store.init();
  check('picks the github backend', info.mode==='github', info.mode);
  check('missing files start empty', (await store.read('users')).length===0);

  await store.update('users', (r)=>{ r.push({id:'usr_1',name:'Ajay'}); }, 'add user');
  check('writes to data/users.json', Boolean(files['data/users.json']), Object.keys(files).join());
  check('commits pretty JSON', decode('data/users.json')[0].name==='Ajay');

  await store.update('users', (r)=>{ r.push({id:'usr_2',name:'Priya'}); });
  check('second write reuses the sha (no conflict)', decode('data/users.json').length===2);

  check('read returns a copy, not the cache', await (async()=>{
    const a = await store.read('users'); a[0].name='MUTATED';
    const b = await store.read('users'); return b[0].name==='Ajay';
  })());

  force409Once = true;
  await store.update('users', (r)=>{ r.push({id:'usr_3',name:'Sam'}); });
  check('recovers from a 409 by re-reading the sha', decode('data/users.json').length===3);

  // 20 concurrent writers must not lose an update
  await Promise.all(Array.from({length:20},(_,i)=>
    store.update('tasks',(r)=>{ r.push({id:`tsk_${i}`}); })));
  check('20 concurrent writes all land', decode('data/tasks.json').length===20,
        String(decode('data/tasks.json').length));

  // a failed mutator must not wedge the queue
  await store.update('tasks', ()=>{ throw new Error('boom'); }).catch(()=>{});
  await store.update('tasks', (r)=>{ r.push({id:'after_error'}); });
  check('queue survives a thrown mutator', decode('data/tasks.json').some(t=>t.id==='after_error'));

  console.log(`\n${fail===0?'\x1b[32m':'\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail?1:0);
})();
