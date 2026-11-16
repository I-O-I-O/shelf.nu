// Node 22.20+: strip types without loading the application, Prisma, or migrations.
// Run from apps/webapp, with the existing server environment already loaded.
try {
  const modulePath = new URL(
    "../app/modules/backup/service.server.ts",
    import.meta.url
  ).href;
  const { startBackup } = await import(modulePath);
  const { completion } = await startBackup();
  const success = await completion;
  process.stdout.write(
    success
      ? "Database backup successful and verified.\n"
      : "Database backup failed; inspect private metadata and server configuration.\n"
  );
  process.exitCode = success ? 0 : 1;
} catch {
  process.stderr.write(
    "Database backup could not start; check configuration, tools, permissions and lock.\n"
  );
  process.exitCode = 1;
}
