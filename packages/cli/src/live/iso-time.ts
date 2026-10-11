// The one way a time is written in the files of the live check (a stored result, the ledger), and the one
// test of whether text is a time that was written that way.

/** What `Date#toISOString` writes, and nothing `Date.parse` is lenient about. */
export const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** True for a time that prints back as it was written: a day that does not exist (`02-31`) is moved. */
export const isRealTime = (text: string): boolean => {
  const time = new Date(text);
  return !Number.isNaN(time.getTime()) && time.toISOString() === text;
};
