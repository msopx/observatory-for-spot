/**
 * Public identity of the released source tree. Every corresponding-source
 * link in the interface, the release packager and the browser tests read
 * these values so that a rename or a new release changes one file.
 */
export const REPOSITORY_URL =
  "https://github.com/msopx/observatory-for-spot";
/** Must equal the `version` in package.json and release/release.json. */
export const RELEASE_VERSION = "1.0.0";
export const RELEASE_TAG = `v${RELEASE_VERSION}`;
/** The exact tagged tree, not the moving default branch. */
export const RELEASE_TREE_URL = `${REPOSITORY_URL}/tree/${RELEASE_TAG}`;
export const RELEASE_ARCHIVE_PREFIX = `observatory-for-spot-${RELEASE_VERSION}`;
export const SOURCE_ARCHIVE_NAME = `${RELEASE_ARCHIVE_PREFIX}-source.tar.gz`;
/** Served from the static export once `package:release` has copied it in. */
export const SOURCE_ARCHIVE_PATH = `/source/${SOURCE_ARCHIVE_NAME}`;
export const SOURCE_ARCHIVE_CHECKSUM_PATH = `${SOURCE_ARCHIVE_PATH}.sha256`;
