#!/bin/sh
set -eu

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 \
  --set app_password="$APP_DATABASE_PASSWORD" \
  --set migration_password="$MIGRATION_DATABASE_PASSWORD" <<'SQL'
CREATE ROLE wager_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'migration_password';
CREATE ROLE wager_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
ALTER DATABASE wagering OWNER TO wager_migrator;
SQL
