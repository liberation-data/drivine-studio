# Drivine Studio

Browse a [Drivine](https://github.com/liberation-data) model, load its views and fragments as `loadAll` does, and
see what came back as a graph; run Cypher, and see it as a graph or as rows. The studio reads and never writes.

The browser app talks only to this app's own server, which connects to the databases with Drivine (TypeScript). The
same build runs from `npm start`, as a desktop app in Electron, and is meant to run in a container too.

## Model files

Each Drivine library writes a module's model as `.drivine/model.json`, beside its build file, when it builds: its
fragments, relationship fragments and views, and how each is stored. The
[format](https://github.com/liberation-data/drivine-cypher-spec/tree/main/model) is shared by the three libraries.

The Catalogue's Folders sheet names the folders the studio looks in: each, and the folders in it, for model files,
leaving out those a build fills (`node_modules`, `build`, `target` and the like). A model file may be named itself.
`DRIVINE_STUDIO_MODELS` names more, separated as `PATH` is. The studio keeps the rest in `models.json` in its home.

It reads the files afresh for each load, so a model the build has just written is the one loaded. Every module's
entries are merged by id. An entry the code no longer declares is greyed out, as the store may still hold it; an id
current in one module and removed in another, as when a class moves, is the current one.

## Loading

Drag a view or fragment to the Canvas, and the studio loads it on the connection in use. Drivine (TypeScript) writes
the Cypher, from Drivine's own models of the file's entries and its own query DSL: the Cypher `loadAll` runs for the
query, which the Canvas shows, and opens in the Cypher window. Conditions are on the root's properties, or on the
nodes a relationship leads to, that one of them meets them or that none does; the roots are ordered by a property of
the root, and limited.

What comes back is drawn as a graph. A node is told apart by its fragment's id, and one whose fragment has none by
all it holds. A temporal value in a condition goes over Bolt as a Bolt temporal value, as drivine4j stores one, and to
FalkorDB as text.

## Icons

Each label in a graph is drawn with an icon from [Lucide](https://lucide.dev), found in this order:

1. **The one you chose.** Press a label in the graph's legend to choose another, or none, or Automatic to have it
   found again. An icon is a label's: a node's first label, the one it is told by, so a choice shows on the Canvas
   and in the Cypher window alike, for every model with the label. The studio keeps your choices in `icons.json` in
   its home.
2. **A common word in the label.** About eighty words, such as Person, Organization, Issue, Order and Note, each
   with its icon. The label's words are looked up whole, then each from the last, so `GithubPerson` is a person and
   `SampleDocNode` a document.
3. **The nearest icon by meaning.** A small local model, `all-MiniLM-L6-v2` (23 MB, quantized, on the CPU),
   compares the label's words with each icon's name and tags, and takes the nearest. The icon is used only when it
   is near enough: below that, the model was as often wrong as right in a test of sixty labels, and the node is drawn
   plain.

The model is downloaded once, the first time a label needs it, to `models` in the studio's home; offline before then,
labels get their chosen and common-word icons alone, and the download is tried again a minute later. The icons' own
vectors are in the repository, made by `npm run icon-vectors` after an upgrade of Lucide or the model.

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

Drivine (TypeScript) runs SQL on Postgres and Oracle, not Cypher, so the Cypher window does not run there yet, and
the Connections window keeps them without testing them.

The server answers only the studio's own pages, on `localhost`: a page of another site, or one whose name has been
pointed at this machine, is refused. `DRIVINE_STUDIO_ALLOWED_HOSTS` names the hosts to answer to in its place, as a
container behind a name of its own needs.

## Trying it

```sh
npm install
npm run dev                                    # http://localhost:5187
```

Add a connection in the Connections window, and a folder with model files in the Catalogue's Folders sheet: a
drivine4j checkout, say, whose `drivine4j-sample` has one. Then drag a view to the Canvas, or run Cypher in the
Cypher window.

`npm run build && npm start` serves the standalone build on the same port. `npm test` runs the tests, and
`npm run test:db` the ones against Neo4j and FalkorDB, in Docker, the sample domain's loads among them.

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

- Model files read straight from GitHub, with nothing built.
- Conditions on a relationship's own properties, and along a path.
- Cypher on Oracle and Postgres, once Drivine (TypeScript) compiles it to SQL as drivine4j does.
- A container image, from the same standalone build.

## License

Apache-2.0
