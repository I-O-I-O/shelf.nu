export type HandbookFileAttachment = {
  id: string;
  title: string;
  fileName: string;
  fileSizeBytes: number;
};

export function formatHandbookFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function HandbookFileList({
  files,
  versionId,
  title = "Files",
}: {
  files: HandbookFileAttachment[];
  versionId?: string;
  title?: string;
}) {
  if (!files.length) return null;
  return (
    <section className="mt-6 rounded-xl border border-gray-200 bg-gray-50 p-4">
      <h2 className="text-base font-semibold text-gray-950">{title}</h2>
      <ul className="mt-3 space-y-2">
        {files.map((file) => (
          <li
            key={file.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white p-3"
          >
            <div className="min-w-0">
              <p className="break-words text-sm font-semibold text-gray-900">
                {file.title === file.fileName ? file.fileName : file.title}
              </p>
              <p className="mt-0.5 break-all text-xs text-gray-600">
                {file.title === file.fileName
                  ? formatHandbookFileSize(file.fileSizeBytes)
                  : `${file.fileName} · ${formatHandbookFileSize(
                      file.fileSizeBytes
                    )}`}
              </p>
            </div>
            <a
              href={`/api/handbook-attachment?sourceId=${encodeURIComponent(
                file.id
              )}${
                versionId ? `&versionId=${encodeURIComponent(versionId)}` : ""
              }`}
              className="inline-flex h-9 shrink-0 items-center rounded-lg border border-gray-300 px-3 text-sm font-semibold text-gray-800 hover:bg-gray-50"
            >
              Download
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
