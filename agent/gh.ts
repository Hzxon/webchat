// The GitHub CLI that only the keyholder uses (docs/decisions/locked-room.md). Setup downloads the
// release archive for this system, checks its SHA-256 against the table below, which a release of
// WebChat reviews, and installs the program root-owned. The keyholder never runs Homebrew's `gh`,
// since the owner can write that folder.

import { createHash } from 'node:crypto';

/** Update the version and the four sums together, from the release's `gh_<version>_checksums.txt`. */
export const GH_VERSION = '2.104.0';
const SUMS: Record<string, string> = {
  'linux_amd64.tar.gz': '98cb101ad87dbbd3f6b2f2bfcbd43197ccd07643140121d8a9cfaa91eadbc24e',
  'linux_arm64.tar.gz': 'cb34cefc6f4e77b90731374a2b737516bb8f3033c6ca46aa949e5344f68069e3',
  'macOS_amd64.zip': 'a8c2a708dbae89dc7c05ba7b0beafc95bd8d09ab4a3505467b77d32ebf364dc6',
  'macOS_arm64.zip': '23b12706219b9892e44236f988444a24adcf29284e16b35e03ba5b863fb6eb8e',
};

/** The archive for a system, or undefined where `gh` ships none. */
export function ghAsset(platform: NodeJS.Platform, arch: string) {
  const key = `${platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'linux' : ''}_${arch === 'x64' ? 'amd64' : arch}.${platform === 'darwin' ? 'zip' : 'tar.gz'}`;
  const sha256 = SUMS[key];
  const name = `gh_${GH_VERSION}_${key}`;
  return sha256 ? { name, sha256, url: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/${name}` } : undefined;
}

/** The archive's bytes, which must hash to the pinned sum. `fetcher` is a test's way to serve one. */
export async function ghArchive(asset: NonNullable<ReturnType<typeof ghAsset>>, fetcher: typeof fetch = fetch) {
  const response = await fetcher(asset.url);
  if (!response.ok) throw new Error(`Downloading ${asset.url} failed with ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error(`${asset.name} does not match the sum WebChat pins for it, so setup did not install it.`);
  return bytes;
}
