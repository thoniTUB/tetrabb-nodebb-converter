# tetraBB to NodeBB Migration

A script to migrate posts from a tetraBB folder structure to a NodeBB Forum using the Read/Write-API.

## Installation

Clone this repo and run 
```bash
$ npm install
```
to install the dependencies.

## Usage
The script requires some arguments:
```bash
node app.mjs --help
Options:
      --help          Show help                                        [boolean]
      --version       Show version number                              [boolean]
  -t, --token         A master token to access the nodebb api. Master tokens
                      must be created with uid=0                      [required]
  -u, --nodebb-url    The base url of the nodebb forum to migrate to
                                   [required] [default: "http://localhost:4567"]
  -c, --cat-id        The category id of the NodeBB category          [required]
  -f, --tetra-folder  The folder under which to search for tetra forum posts
                                                       [required] [default: "."]
  -m, --pid-map       File to load/save the mapping of migrated post ids
                      (Tetra->NodeBB).[required] [default: "migration_map.json"]
```

If you have
* a local NodeBB installation running under `http://localhost:4567`,
* created a `<master token>` (ACP > Settings > API Access > Generate a token with uid=0 ),
* the `<cat-id>` of a category in NodeBB
* and the tetraBB posts in `</path/to/posts/>`,

then run:
```
node app.mjs -t <master token> -c <cat-id> -f </path/to/posts/>
```