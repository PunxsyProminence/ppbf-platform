'use client';

import { useState } from 'react';
import { apiBase } from '@/lib/apiBase';
import {
  ARCHIVE_ACQUISITION_CHANNELS,
  ARCHIVE_VERSION_KINDS,
  fileLibraryPdfOriginal,
  type ArchiveAcquisitionChannel,
  type ArchiveVersionKind,
  type FiledOriginal,
  type IntakeShelf,
} from '@/src/client/libraryTextIntake';

/* Lane L57 (issue #345): files the PDF read in the Add Source Text panel in the
   SharePoint Research Archive, in the folder for its source's subject, and
   records where it went. The app keeps no copy of the PDF (OD-2026-10-02-013
   4A). Shown only where filing is on for the shelf (the archive-original
   route's GET). If filing fails, excerpts still save, unlinked, and the box
   says so (Overwatch Q3, 2026-10-18). The panel mounts one box per PDF read. */

/** Why an excerpt saved now is, or is not, linked to what was filed. */
export type ArchiveLinkState = 'linked' | 'other_source' | 'different_file';

// PROPOSED wording, lane L57: awaiting Jason's approval.
export const FILING_WORDS = {
  heading: 'File the original',
  help: "Files this PDF in the SharePoint Research Archive, in the folder for this source's subject. The app keeps only the excerpts you save.",
  provider: 'Where it came from',
  providerPlaceholder: 'e.g. Penn State University Libraries',
  channel: 'How it was obtained',
  channels: {
    library_database: 'Library database',
    publisher_site: 'Publisher site',
    open_access_repository: 'Open-access repository',
    author_copy: 'Copy from the author',
    ppbf_created: 'Made by PPBF',
    other: 'Other',
  } satisfies Record<ArchiveAcquisitionChannel, string>,
  version: 'Which version',
  versions: {
    version_of_record: 'Published version',
    accepted_manuscript: 'Accepted manuscript',
    author_original: "Author's original (preprint)",
    corrected_version_of_record: 'Corrected published version',
    other: 'Other',
    unknown: 'Not sure',
  } satisfies Record<ArchiveVersionKind, string>,
  acquiredAt: 'Date obtained (optional)',
  file: 'File in the Research Archive',
  filing: 'Filing…',
  chooseSource: 'Choose the source first: its subject decides the archive folder.',
  filed: (folder: string, name: string) => `Filed in the Research Archive: ${folder} / ${name}.`,
  alreadyFiled: (folder: string, name: string) => `Already filed in the Research Archive: ${folder} / ${name}.`,
  open: 'Open in SharePoint',
  linked: 'Excerpts you take from its pages with "Use this page" are linked to the filed original.',
  otherSource: 'This PDF was filed for another source, so excerpts saved for this one are not linked to it.',
  differentFile: 'The PDF on screen is not the file that was filed, so excerpts from it are not linked.',
  notYet: 'Excerpts are linked to a filed original only after you file this PDF here. If it was filed before, filing finds it.',
  notFiled: (reason: string) => `Not filed: ${reason} Excerpts you save now are not linked to a filed original.`,
  // The write may have landed and its answer been lost; the server says to retry with the same file.
  mayNotBeFiled: (reason: string) => `May not be filed: ${reason} Excerpts you save now are not linked to a filed original.`,
  failed: 'the Research Archive did not answer. Try again with the same file.',
};

export default function ArchiveFilingBox({
  file,
  sourceId,
  shelf,
  disabled,
  filed,
  linkState,
  onFiled,
}: {
  readonly file: File;
  readonly sourceId: string;
  readonly shelf?: IntakeShelf;
  readonly disabled: boolean;
  /** What this PDF was filed as in this session, if anything. */
  readonly filed: FiledOriginal | null;
  readonly linkState: ArchiveLinkState;
  /** Called with the file it was filed from, so a late answer for another PDF is not taken for this one. */
  readonly onFiled: (original: FiledOriginal, file: File) => void;
}) {
  const [provider, setProvider] = useState('');
  const [channel, setChannel] = useState<ArchiveAcquisitionChannel>('library_database');
  const [version, setVersion] = useState<ArchiveVersionKind>('unknown');
  const [acquiredAt, setAcquiredAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [alreadyFiled, setAlreadyFiled] = useState(false);

  async function handleFile() {
    if (!sourceId) {
      setMessage(FILING_WORDS.chooseSource);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await fileLibraryPdfOriginal(apiBase(), file, {
        sourceId,
        acquisitionProvider: provider,
        acquisitionChannel: channel,
        versionKind: version,
        acquiredAt,
        ...(shelf === 'platform' ? { shelf } : {}),
      });
      if (result.ok) {
        setAlreadyFiled(result.alreadyFiled);
        onFiled(result.original, file);
      } else {
        // A refusal (4xx) is definite; no answer or a server error may have landed.
        const definite = result.status >= 400 && result.status < 500;
        const reason = result.serverMessage ?? FILING_WORDS.failed;
        setMessage(definite ? FILING_WORDS.notFiled(reason) : FILING_WORDS.mayNotBeFiled(reason));
      }
    } finally {
      setBusy(false);
    }
  }

  const linkSentence = linkState === 'linked'
    ? FILING_WORDS.linked
    : linkState === 'other_source' ? FILING_WORDS.otherSource : FILING_WORDS.differentFile;

  return (
    <div className="space-y-[var(--s2)]" aria-label={FILING_WORDS.heading} role="group">
      <span className="t-label">{FILING_WORDS.heading}</span>
      <p className="t-muted">{FILING_WORDS.help}</p>
      {filed ? (
        <div role="status" className="space-y-[var(--s1)]">
          <p className="t-body">
            {(alreadyFiled ? FILING_WORDS.alreadyFiled : FILING_WORDS.filed)(filed.archiveDomainCode, filed.archiveFilename)}{' '}
            {filed.webUrl ? (
              <a href={filed.webUrl} target="_blank" rel="noreferrer" className="underline">{FILING_WORDS.open}</a>
            ) : null}
          </p>
          <p className="t-muted">{linkSentence}</p>
        </div>
      ) : (
        <>
          <div className="grid gap-[var(--s3)] md:grid-cols-2">
            <label className="field md:col-span-2">
              <span className="t-label">{FILING_WORDS.provider}</span>
              <input aria-label={FILING_WORDS.provider} className="input" value={provider} disabled={disabled || busy}
                placeholder={FILING_WORDS.providerPlaceholder} onChange={(event) => setProvider(event.target.value)} />
            </label>
            <label className="field">
              <span className="t-label">{FILING_WORDS.channel}</span>
              <select aria-label={FILING_WORDS.channel} className="select" value={channel} disabled={disabled || busy}
                onChange={(event) => setChannel(event.target.value as ArchiveAcquisitionChannel)}>
                {ARCHIVE_ACQUISITION_CHANNELS.map((value) => (
                  <option key={value} value={value}>{FILING_WORDS.channels[value]}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="t-label">{FILING_WORDS.version}</span>
              <select aria-label={FILING_WORDS.version} className="select" value={version} disabled={disabled || busy}
                onChange={(event) => setVersion(event.target.value as ArchiveVersionKind)}>
                {ARCHIVE_VERSION_KINDS.map((value) => (
                  <option key={value} value={value}>{FILING_WORDS.versions[value]}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="t-label">{FILING_WORDS.acquiredAt}</span>
              <input type="date" aria-label={FILING_WORDS.acquiredAt} className="input" value={acquiredAt}
                disabled={disabled || busy} onChange={(event) => setAcquiredAt(event.target.value)} />
            </label>
          </div>
          <button type="button" className="btn btn--ghost" disabled={disabled || busy} onClick={() => void handleFile()}>
            {busy ? FILING_WORDS.filing : FILING_WORDS.file}
          </button>
          {message ? <p className="t-body" role="alert">{message}</p> : <p className="t-muted">{FILING_WORDS.notYet}</p>}
        </>
      )}
    </div>
  );
}
