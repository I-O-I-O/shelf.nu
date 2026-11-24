# Handbook file attachments

Handbook attachments are stored as private Shelf Storage objects in the
`assets` bucket. The existing `HandbookSource` record identifies each object;
the article's editable draft points to its selected files, and each published
`HandbookArticleVersion` records its own source links. Removing a draft file
therefore does not remove a file already used by a published version.

The editor accepts `.ino`, `.c`, `.cpp`, `.h`, `.hpp`, `.py`, `.js`, `.ts`,
`.json`, `.txt`, `.md`, `.csv`, `.yaml`, `.yml`, `.pdf`, and `.zip` files. A
draft may have up to five attachments, each up to 10 MB. Text files must be
UTF-8; PDFs and ZIP files must have their expected signatures. Storage records
files as `application/octet-stream`, and the download route signs a short-lived
attachment download after checking Handbook read access and the article or
version relationship. Uploaded code and archives are never executed or
extracted by the application.

Apply the migration in
`packages/database/prisma/migrations/20261109120000_handbook_article_file_attachments`
before using this feature in an environment.
