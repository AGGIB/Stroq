// Words that are not a package.
//
// A flagged page says "run npx install" or "the class you want", and an agent that later runs
// `npx class` has not been told to run a package of that name by anything. The card counts a command
// as told by text only when it runs a package the text named, so a word of ordinary English (or of
// ordinary documentation: `install`, `build`, `config`) is never taken for one. The list is the most
// common English words and the words README prose is made of, plus the names of the tools that run
// packages. A real package that is also a plain word (`chalk`) is not here: it is as likely to be a
// package as a word, and the other conditions of the rule decide.
const WORDS = `
a about above across action actions add after again against all almost alone along already also
although always am among an and another any anything app apps are area areas around as ask at away
back bar base be because been before being below best better between big bin both build builds building bun bunx bundle but by
cache call can cargo case change check class classes clean cli close code come command commands
common config configs configure context core could create current data day days delete deno deploy dev did
different do doc docs does done down during each early either else end enough even ever every
example examples exec exit extra face fact false far feature features few file files find first
fix flag flags folder follow for form format found foo free from full function functions get give global helper helpers
go going good great group had hand hard has have he help her here high him his home how however
i if import in include info init initial input install installed installer installing into is
issue it its job just keep key keys kind know large last late later latest lib libs library
license like line link lint list little local long look lot main make many may me mean might module
modules more most move much must my name names need never new next no node not note notes now npm
npx number of off often old on once one only open option options or order other our out output
over own package packages page pages part path people pip pipx place plan please plugin plugins pnpm pnpx point
possible project public publish put python python3 question quick quickly rather read readme real really
release remove repo repository require required result results right root rule rules run runs
same save say scope script scripts see seem serve set setup several she should show side simple since
small so some something source start started step steps still stop such sudo support sure system
take task tasks tell template templates test tests text than that the their them then there these they thing things
think this those though through time tip to together tool tools too true try turn two type types
under until up update upgrade us use used user users using util utils uv uvx value values version versions
very via want was watch way we web well were what when where whether which while who whole why will
with within without work world would write yarn yes yet you your
`;

/** The words, lower case. */
export const COMMON_WORDS: ReadonlySet<string> = new Set(
  WORDS.split(/\s+/).filter((w) => w !== ''),
);

/** Whether a package name is one of those words. */
export const isCommonWord = (name: string): boolean => COMMON_WORDS.has(name.toLowerCase());
