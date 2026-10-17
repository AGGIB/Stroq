// V8 as the oracle for "which names does this text read". It runs as a child of the test, started with
// --experimental-vm-modules, and answers on stdout. A snippet is run in a context whose global object is a Proxy that
// answers every name with another Proxy and records the name, so that `x.createRequire(1)`, `eval('1')`,
// `process.mainModule.require('x')` and `` `${x.eval}` `` all run to the end and say which names they read. Nothing in
// it is real: no file, process or module is reachable from the snippets.
//
// Input (JSON on stdin):
//   { "mode": "reads", "items": [{ "code": "...", "goal": "script" | "module" }] }
//     -> [{ "accepted": boolean, "reads": ["name", ...] }]
//   { "mode": "sweep", "shapes": [{ "text": "...\u0001...", "needs": ["x"] }], "name": "createRequire", "from": 0, "to": 65535, "step": 1 }
//     -> { "ran": [{ "shape": 0, "cp": 9 }, ...] }   the shapes that V8 ran with the code point put where \u0001 stands,
//        and in which it read the name and every name in `needs` (a code point that joins the receiver to the dot makes
//        another name of it, which the stubs answer all the same)
//   { "mode": "identifier", "name": "eval", "from": 0, "to": 65535, "step": 1 }
//     -> { "after": [cp, ...], "before": [cp, ...] }  the code points that V8 reads as part of the name
import vm from 'node:vm';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));

function world() {
  const keys = new Set();
  const answer = (key) => {
    if (typeof key !== 'string') return undefined;
    keys.add(key);
    return stub;
  };
  const stub = new Proxy(function () {}, {
    get: (_target, key) => answer(key),
    apply: () => stub,
    construct: () => stub,
    has: () => true,
    set: () => true,
    deleteProperty: () => true,
  });
  const global = new Proxy(
    {},
    {
      get: (_target, key) => answer(key),
      has: () => true,
      set: () => true,
      getOwnPropertyDescriptor: () => undefined,
    },
  );
  return { keys, context: vm.createContext(global) };
}

async function run(code, goal) {
  const { keys, context } = world();
  try {
    if (goal === 'module') {
      const module = new vm.SourceTextModule(code, { context });
      try {
        await module.link(() => {
          throw new Error('a snippet has no imports');
        });
        await module.evaluate({ timeout: 200 });
      } catch {
        // It was accepted; what it did after that does not matter.
      }
    } else {
      const script = new vm.Script(code);
      try {
        script.runInContext(context, { timeout: 200 });
      } catch {
        // Accepted, and stopped by what it tried to do.
      }
    }
  } catch {
    return { accepted: false, reads: [] };
  }
  return { accepted: true, reads: [...keys] };
}

/** Each snippet has its own lexical scope: declarations must not poison the next shape or code point. */
function quick(code, context, keys) {
  keys.clear();
  try {
    new vm.Script(`{\n${code}\n}`).runInContext(context, { timeout: 50 });
  } catch (error) {
    if (error instanceof SyntaxError) return false;
  }
  return true;
}

const codePoints = function* ({ points, from, to, step }) {
  if (points !== undefined) yield* points;
  else for (let cp = from; cp <= to; cp += step) if (cp < 0xd800 || cp > 0xdfff) yield cp;
};

if (input.mode === 'reads') {
  const out = [];
  for (const { code, goal } of input.items) out.push(await run(code, goal));
  process.stdout.write(JSON.stringify(out));
} else if (input.mode === 'sweep') {
  const { keys, context } = world();
  const ran = [];
  for (const cp of codePoints(input)) {
    const char = String.fromCodePoint(cp);
    for (const [shape, { text, needs }] of input.shapes.entries()) {
      const code = text.replaceAll('\u0001', char);
      if (quick(code, context, keys) && keys.has(input.name) && needs.every((n) => keys.has(n)))
        ran.push({ shape, cp });
    }
  }
  process.stdout.write(JSON.stringify({ ran }));
} else if (input.mode === 'identifier') {
  const { keys, context } = world();
  const after = [];
  const before = [];
  for (const cp of codePoints(input)) {
    const char = String.fromCodePoint(cp);
    if (quick(`x.${input.name}${char}`, context, keys) && keys.has(`${input.name}${char}`))
      after.push(cp);
    if (quick(`x.${char}${input.name}`, context, keys) && keys.has(`${char}${input.name}`))
      before.push(cp);
  }
  process.stdout.write(JSON.stringify({ after, before }));
}
