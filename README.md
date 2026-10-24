# Drivine Studio

Browse a [Drivine](https://github.com/liberation-data) model, load its views and fragments, and see what
came back as a graph. The studio reads and never writes.

The browser app talks only to this app's own server. Today that server passes each call on to the
endpoints an application serves with
[`drivine4j-studio`](https://github.com/liberation-data/drivine4j/tree/main/drivine4j-studio); the same
build runs from `npm start`, as a desktop app in Electron, and is meant to run in a container too.

## Trying it

Start an application with `@EnableDrivineStudio`, or the drivine4j demo (the sample domain, seeded, on
`:8087`; needs Docker):

```sh
./gradlew :drivine4j-studio:studioDemo        # in drivine4j
```

Then:

```sh
npm install
npm run dev                                    # http://localhost:5187
```

`DRIVINE_STUDIO_API` names the endpoints when they are not the demo's,
`http://localhost:8087/drivine/studio/api`.

`npm run build && npm start` serves the standalone build on the same port. `npm test` runs the tests.

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
- Plain Cypher, typed in, on any Drivine datasource: Neo4j and its kin directly, Oracle and Postgres
  through Drivine's Cypher compiler. The query builder writes the Cypher `loadAll` would run.
- The server running Drivine (TypeScript) itself, rather than passing calls on.
- A container image, from the same standalone build.

## License

Apache-2.0
