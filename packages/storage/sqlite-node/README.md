# @earendil-works/pi-storage-sqlite-node

Node sqlite storage backend for `@earendil-works/pi-agent-core` sessions. Provides the
`node:sqlite` adapter (`SqliteDatabase` implementation) and the SQLite session
session collection (`createSqliteSessionCollection`, migrations, materialized views). The
collection lazily owns one shared database connection and implements `AsyncDisposable`.

```ts
await using collection = createSqliteSessionCollection(options);
const search = createSqliteSessionSearch(options);
const repository = createSessionRepository({ collection, search });
```
