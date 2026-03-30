const NATO_PHONETIC = [
  'Alpha',
  'Bravo',
  'Charlie',
  'Delta',
  'Echo',
  'Foxtrot',
  'Golf',
  'Hotel',
  'India',
  'Juliet',
  'Kilo',
  'Lima',
  'Mike',
  'November',
  'Oscar',
  'Papa',
  'Quebec',
  'Romeo',
  'Sierra',
  'Tango',
  'Uniform',
  'Victor',
  'Whiskey',
  'X-ray',
  'Yankee',
  'Zulu',
];

/**
 * Returns the next unique label for a placed asset, using NATO phonetic
 * suffixes (Alpha, Bravo, …) based on how many of that asset_type already
 * exist in the current session's placed assets.
 */
export function nextAssetLabel(
  assetType: string,
  baseLabel: string,
  existingPlacements: Array<{ asset_type: string }>,
): string {
  const count = existingPlacements.filter((p) => p.asset_type === assetType).length;
  const suffix = count < NATO_PHONETIC.length ? NATO_PHONETIC[count] : `${count + 1}`;
  return `${baseLabel} ${suffix}`;
}
