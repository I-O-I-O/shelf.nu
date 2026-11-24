# IOIO database backups

This feature backs up the **one entire PostgreSQL database** identified by the
existing `DIRECT_URL` (preferred, because Shelf's `DATABASE_URL` may use transaction
pooling), falling back to `DATABASE_URL`. This is server-wide, across workspaces.
Only IOIO Team staff (OWNER/ADMIN through Shelf's existing authorization) may
inspect status or start a backup. There is no download or restore web endpoint.
No schema change, migration, seed, or Prisma access is involved.

## Scope and limits

The dump contains database schema and data accessible to the configured database
role. Use an existing direct database connection with sufficient read privileges
for every required schema. A failed privilege check fails the backup. This does
not back up PostgreSQL cluster roles, server configuration, secrets, the app code,
or storage object bytes. Asset images, Handbook images/attachments, and other
uploads use **Supabase Storage**, outside PostgreSQL. Their database references
are included; their actual files are **not**. Arrange separate storage backups.
This is not a complete application/disaster recovery backup. Private local dumps
also need a separately managed encrypted off-server copy for disk/server loss.

PostgreSQL's [pg_dump documentation](https://www.postgresql.org/docs/current/app-pgdump.html)
and [pg_restore documentation](https://www.postgresql.org/docs/current/app-pgrestore.html)
explain custom-format archives. `pg_restore --list` checks the archive table of
contents; it is not proof of a complete restore. Regularly perform an isolated
restore drill, including verifying the separately backed up Storage objects.

## Server configuration

- Node **22.20+** (already the repository minimum).
- `pg_dump` and `pg_restore` on the process PATH. Install a PostgreSQL client major
  matching the database server (or a newer supported client). An older pg_dump
  refuses a newer server. Both Dockerfiles now install Debian's `postgresql-client`
  (Bookworm supplies PostgreSQL 15); adjust the image/client source if your server
  is newer. Images have not been built or deployed as part of this change.
- `IOIO_BACKUP_DIR`: default `/var/lib/ioio-shelf/backups`, absolute, private,
  outside the app checkout, public/static directories, and web-server aliases.
  Keep it on persistent storage. A new directory is created mode 0700; an existing
  directory with group/world permissions or a symlink is rejected. Dumps and JSON
  metadata are 0600. Parent directories must be administrator-owned or otherwise
  protected from untrusted writes. Never serve this directory with nginx/CDN.
- `IOIO_BACKUP_RETENTION`: integer 1–365, default **7** daily recovery points.
- `IOIO_BACKUP_SCHEDULE_CONFIRMED`: default false. Set true in the **web service**
  only after enabling and checking the independent scheduler. The UI calls this
  enabled based on administrator confirmation; it cannot inspect systemd from
  inside a container. Unset it if the timer is disabled. No next-run time is shown
  because timer state, host timezone, and container timezone are not reliably
  available to the web process. Confirm actual next run with `systemctl list-timers`.
- Reuse the web service's `DIRECT_URL`/`DATABASE_URL`. Do not create another backup
  database credential. Prisma query parameters are removed; libpq gets database
  connection fields and SSL options through a child-only environment, never argv.
  URL SSL options supported: sslmode, sslrootcert, sslcert, sslkey. Certificate
  paths must be readable by the runtime. PostgreSQL tools run with output discarded
  to prevent errors containing connection details leaking into logs or responses.

Do not copy secrets into command arguments, tickets, or logs. The CLI does not
load `.env` itself. For a source installation you can use Node's `--env-file` with
the existing root `.env`, or systemd's `EnvironmentFile` if it is compatible with
systemd environment-file syntax. Never source a dotenv file as a shell script.

## Scheduling on the IOIO Linux server (administrator only)

Repository inspection found Docker/Fly deployment files, a Node web entrypoint,
and upstream deployment documentation, **but no IOIO host systemd/cron definition
or authoritative live server paths**. The supplied timer is therefore a template
for the requested Linux server, not a claim about its present topology. No server
was contacted or changed. First inspect the existing web service/container user,
paths, network, PostgreSQL version, environment loading, and persistent mounts.
Use **one** scheduler and one private backup directory shared with all web workers.
An ephemeral container filesystem is unsuitable. Do not use this design across
hosts without a filesystem supporting atomic mkdir/rename shared by all workers.

### Native Node service

Review `deploy/systemd/ioio-shelf-backup.service` and `.timer`. Edit User, Group,
WorkingDirectory, Node path, EnvironmentFile, and ReadWritePaths to match the
existing installation. The service must use the **same Unix account** as the web
app so both can access mode-0700 backups. No root database job is needed.

Example commands, **to be run manually on the server after review**:

```sh
sudo install -d -m 0700 -o ioio-shelf -g ioio-shelf /var/lib/ioio-shelf/backups
# Prepare /etc/ioio-shelf/backup.env privately (0600), using the existing
# service connection settings and backup options. No shell interpolation.
sudo install -m 0644 deploy/systemd/ioio-shelf-backup.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/ioio-shelf-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
# Manual first test: creates a real backup and applies retention after success.
sudo systemctl start ioio-shelf-backup.service
sudo systemctl status ioio-shelf-backup.service
# Only enable once the first backup is inspected.
sudo systemctl enable --now ioio-shelf-backup.timer
systemctl list-timers ioio-shelf-backup.timer
```

The timer fires daily around **03:00 host local time** (one-minute accuracy).
`Persistent=true` runs one catch-up job after downtime, not one per missed day.
Inspect `timedatectl` and timer output, including DST behavior. Then set
`IOIO_BACKUP_SCHEDULE_CONFIRMED=true` in the web environment and restart the web
service through the normal deployment process. Add timer failure monitoring using
existing server monitoring; the dashboard alone is not an alerting system.

### Docker web service

Build/review the image first; ensure PostgreSQL clients match the database version.
Bind-mount a private persistent host directory at the configured backup path in
**every web container**, with matching UID ownership and the same environment.
For a host timer that executes inside the existing container, replace the native
service's ExecStart with the following (replace the fixed container name):

```ini
ExecStart=/usr/bin/docker exec --workdir /src/apps/webapp ioio-shelf node --experimental-strip-types scripts/database-backup.mjs
```

Remove the native service's EnvironmentFile, WorkingDirectory, User/Group, and
filesystem sandbox directives that do not apply to Docker exec; use the existing
host's authorized Docker service identity. Docker socket access is privileged.
The process inherits the container's existing credentials and persistent mount.
Do **not** invoke `start.sh` or `docker-entrypoint.sh` for a backup; no application
startup or migration command is needed. A stopped container causes the job to fail
and monitoring should alert. For Fly or multi-host deployments, provision a
persistent volume and an independent scheduler appropriate to that platform
before setting confirmation true; the Linux timer is not automatically installed
by Docker/Fly deployment.

## Manual operation and verification

From a native source checkout's `apps/webapp`, as the web-service account, using
the existing root env file (review that it targets the intended database first):

```sh
node --env-file=../../.env --experimental-strip-types scripts/database-backup.mjs
```

Alternatively use the reviewed oneshot service above or **Back up now** on the
staff dashboard. The manual web action uses the same runner, returns immediately,
and the card polls every three seconds while running (otherwise every 15 seconds).
It shows the resulting successful/failed state, last successful backup, sizes,
and recent verified backups. Work continues if the browser closes. A web-process
restart can interrupt a manual job; the independent daily timer is unaffected.

On the server, select an actual filename from the private directory and verify:

```sh
pg_restore --list /var/lib/ioio-shelf/backups/ACTUAL_FILENAME.dump > /dev/null
```

No file path comes from HTTP input. Successful files use timestamp + random UUID.
`*.incomplete` files are never counted. The runner creates a custom-format dump,
checks nonzero size and `pg_restore --list`, syncs the file, atomically renames it,
and atomically publishes validated JSON metadata. `last-attempt.json` records only
safe timestamps/status; per-dump JSON records filename, creation/completion times,
size, success, and verification. The UI projects validated fields only and checks
the corresponding regular file and size. Missing/malformed metadata is handled
without exposing raw file content or paths.

Retention keeps the newest successful backup on each **UTC date**, for the latest
seven distinct backup dates by default. Extra same-day manual backups do not evict
other days. UTC naming/grouping avoids DST ambiguity even though scheduling is
host-local. No deletion runs until the new dump and its metadata are published.
Failures never prune existing successful dumps. Retention errors preserve the successful result and record a separate retention
warning; administrators should inspect permissions/disk health. Unknown/orphan files are never automatically pruned.

The `.lock` directory is an atomic cross-process lock. Each tool has a one-hour
hard timeout. A failed command removes its incomplete file and releases the lock.
**After a crash/reboot/SIGKILL**, a stale lock deliberately blocks all new jobs.
Inspect `.lock/owner.json` (PID/time), the web service and timer, and running
`pg_dump`/`pg_restore` processes. PID alone is not proof because it can be reused
or be from a container namespace. Only after proving no job is active, stop both
producers and manually remove the stale `.lock` and that job's incomplete file.
Do not automatically age out locks or delete existing dumps. An orphan verified
`.dump` without JSON is not listed or pruned; inspect it manually and retain it.
Metadata/list verification does not detect subsequent bit rot.

## Future manual restoration (no application restore feature)

Restoration is an administrator operation. First restore into a **new isolated
non-production database** to test, with matching extensions and required roles.
Retrieve the dump securely and inspect `pg_restore --list`. Use a reviewed trusted
dump; restoration can execute database code. Supply the isolated target using
standard libpq environment settings or a mode-0600 password file; do not put a
password in command arguments/history. For example, with PGHOST, PGPORT, PGUSER,
PGDATABASE pointing to the isolated target and credentials already configured:

```sh
pg_restore --no-password --exit-on-error --no-owner --no-privileges \
  --dbname="$PGDATABASE" /secure/path/ACTUAL_FILENAME.dump
```

This example omits ownership/ACL restoration. Plan the required roles, grants,
Supabase-managed schemas/extensions and storage restoration for the deployment;
do not blindly apply it to an existing Supabase database. Check row counts,
constraints, authentication, student/staff access, inventory, Handbook links,
and external files in isolation. A later production recovery requires a separate
reviewed outage/recovery plan and explicit authorization. No restore or destructive
database command is run by this feature.

## Validation boundary

Automated tests use temporary directories and simulated external PostgreSQL tools,
plus real status parsing, retention, locks, UI states, and staff/organization gates.
They never connect to production. Actual pg_dump/restore compatibility, database
privileges/coverage, SSL/network connectivity, disk capacity, persistent mounts,
proxy/origin handling, host timezone, timer operation, Docker builds, and a real
restore drill must be verified by an administrator in the intended environment.
