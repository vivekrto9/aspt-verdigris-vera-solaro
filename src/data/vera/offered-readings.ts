// Only the 30-minute sitting is being offered for now, so the public pages show
// one reading even though the catalog, routes and SEO still carry all three.
// Restore the full list here to bring the other readings back.
export const offeredReadingIndexes = [1] as const;

export const isOfferedReading = (index: number) =>
  (offeredReadingIndexes as readonly number[]).includes(index);
