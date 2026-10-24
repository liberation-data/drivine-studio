# Drivine Studio

Run Cypher on a graph database and see what came back as a graph or as rows; browse a
[Drivine](https://github.com/liberation-data) model, load its views and fragments, and see those as a graph too. The
studio reads and never writes.

The browser app talks only to this app's own server, which connects to the databases with Drivine (TypeScript). The
same build runs from `npm start`, as a desktop app in Electron, and is meant to run in a container too.

## Connections

The Connections window adds, tests, changes and removes the databases the studio reads: Neo4j, Memgraph, Neptune,
FalkorDB, Postgres and Oracle. The studio keeps them in `connections.json` in `~/.drivine-studio`, or in
`DRIVINE_STUDIO_HOME`. The file holds passwords, so the studio writes it readable by its owner alone; the browser
is only ever told whether a connection has one.

Drivine's own environment variables, as an application reads them (`DATABASE_TYPE`, `DATABASE_HOST`,
`DATABASE_PORT`, `DATABASE_USER`, `DATABASE_PASSWORD`, `DATABASE_NAME`, `DATABASE_DEFAULT_GRAPH_PATH`), add one more
connection, which the studio cannot change: so a container needs no file. `DRIVINE_STUDIO_CONNECTION_NAME` names it.

## Cypher

The Cypher window runs a statement on the connection in use, with parameters as a JSON object, and shows what came
back as a graph, when there are nodes in it, and as rows. It reads 1000 rows unless told otherwise, and at most
10,000. ⌘↵ runs it.

The studio never writes. Over Bolt (Neo4j, Memgraph, Neptune), a statement runs in a read session, whose
transaction the database will not let write, and which the studio rolls back all the same. On FalkorDB, which has no
transactions, it runs as a read-only query, which FalkorDB will not let write. A procedure that opens transactions of
its own, as some of APOC's do, is beyond both: give the studio a user that may only read, and that is the whole
guarantee.

Drivine (TypeScript) runs SQL on Postgres and Oracle, not Cypher, so the Cypher window does not run there yet.

The server answers only the studio's own pages, on `localhost`: a page of another site, or one whose name has been
pointed at this machine, is refused. `DRIVINE_STUDIO_ALLOWED_HOSTS` names the hosts to answer to in its place, as a
container behind a name of its own needs.

## Trying it

```sh
npm install
npm run dev                                    # http://localhost:5187
```

Add a connection in the Connections window, and run Cypher in the Cypher window.

The Catalogue and Canvas windows still read the endpoints an application serves with
[`drivine4j-studio`](https://github.com/liberation-data/drivine4j/tree/main/drivine4j-studio), until the studio reads
model files. Start an application with `@EnableDrivineStudio`, or the drivine4j demo (the sample domain, seeded, on
`:8087`; needs Docker):

```sh
./gradlew :drivine4j-studio:studioDemo        # in drivine4j
```

`DRIVINE_STUDIO_API` names the endpoints when they are not the demo's,
`http://localhost:8087/drivine/studio/api`.

`npm run build && npm start` serves the standalone build on the same port. `npm test` runs the tests, and
`npm run test:db` the ones against Neo4j and FalkorDB, in Docker.

## Desktop app

The desktop app runs the same standalone server inside Electron and opens a window on it. Its log is
`drivine-studio-electron.log` in the system's temporary directory (on a Mac, Drivine Studio ▸ Open Log File).

```sh
npm run electron            # build, then open the app
npm run electron:watch      # the dev server, with the app on it and its dev tools open
npm run package:mac         # an unpacked app in dist/; package:mac:dmg, package:win, package:linux and package:all too
```

The packages are unsigned, and use Electron's default icon for now.

## Where it is going

- A model file: each Drivine library writes its views and fragments as JSON, and the studio loads it,
  so it no longer needs the application running.
- The query builder writing the Cypher `loadAll` would run, with Drivine (TypeScript), and running it on a connection.
- Cypher on Oracle and Postgres, once Drivine (TypeScript) compiles it to SQL as drivine4j does.
- A container image, from the same standalone build.

## License

Apache-2.0
