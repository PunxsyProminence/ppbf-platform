// The second lock on the door config.ts already locks.
//
// uploadToGoogleDrive used to pass `parents: config.folderId ? [id] : undefined`.
// The undefined branch does not fail: the Google Drive API accepts it and puts
// the file in the SERVICE ACCOUNT's own Drive, which no human on this project
// can open. The call returned 200, the route recorded a success audit row, and
// the document was gone.
//
// config.ts now refuses to build a Drive config without a folder id, so this
// guard is redundant through that path -- and that is exactly why it is worth
// testing. A GoogleDriveConfig can be constructed by any caller, and the
// failure it prevents is silent and unrecoverable.

import { uploadToGoogleDrive } from './googleDrive'

const SERVICE_ACCOUNT = JSON.stringify({
  client_email: 'ingest@example.iam.gserviceaccount.com',
  private_key: 'unused -- the folder guard runs before any network call',
})

describe('uploadToGoogleDrive refuses to upload without a destination folder', () => {
  test('an empty folder id throws instead of uploading to the service account Drive', async () => {
    await expect(
      uploadToGoogleDrive(
        { serviceAccountJson: SERVICE_ACCOUNT, folderId: '' },
        'intake.pdf',
        Buffer.from('%PDF-1.4'),
      ),
    ).rejects.toThrow(/GOOGLE_DRIVE_FOLDER_ID is required/);
  });

  test('a whitespace-only folder id is refused the same way', async () => {
    await expect(
      uploadToGoogleDrive(
        { serviceAccountJson: SERVICE_ACCOUNT, folderId: '   ' },
        'intake.pdf',
        Buffer.from('%PDF-1.4'),
      ),
    ).rejects.toThrow(/GOOGLE_DRIVE_FOLDER_ID is required/);
  });

  test('the refusal explains the consequence, not just the missing variable', async () => {
    // An operator reading "GOOGLE_DRIVE_FOLDER_ID is missing" may reasonably
    // assume a sensible default exists. The message has to say why there is
    // none.
    let message = '';
    try {
      await uploadToGoogleDrive(
        { serviceAccountJson: SERVICE_ACCOUNT, folderId: '' },
        'intake.pdf',
        Buffer.from('%PDF-1.4'),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/service account/i);
    expect(message).toMatch(/nobody can retrieve/i);
  });

  // Guards the guard: the folder check must run BEFORE the service account is
  // parsed, so a deployment missing both reports the one that loses files
  // rather than the one that merely fails loudly.
  test('the folder check runs before the service-account parse', async () => {
    await expect(
      uploadToGoogleDrive(
        { serviceAccountJson: 'not-json-at-all', folderId: '' },
        'intake.pdf',
        Buffer.from('%PDF-1.4'),
      ),
    ).rejects.toThrow(/GOOGLE_DRIVE_FOLDER_ID is required/);
  });
});
