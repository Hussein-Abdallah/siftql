# siftql

> A complete, extensible Lucene-like query language for JavaScript and TypeScript —
> hand-written parser, serializer, and in-memory search engine, with real
> chronological date/time support. Zero runtime dependencies.

[![CI](https://github.com/Hussein-Abdallah/siftql/actions/workflows/ci.yml/badge.svg)](https://github.com/Hussein-Abdallah/siftql/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/siftql.svg)](https://www.npmjs.com/package/siftql)
[![license](https://img.shields.io/npm/l/siftql.svg)](./LICENSE)

> **Status: 0.1.0 in development.** This README is a stub and will be completed
> before publish.

## Install

```sh
npm install siftql
```

## What it is

`siftql` parses a Lucene-style query string into a documented AST, serializes that
AST back to a string, and evaluates it against plain JavaScript objects in memory.

It is a **query-language parser and in-memory filter engine**, not a full-text
search index. If you want relevance-ranked fuzzy search over a document corpus,
reach for Fuse.js, MiniSearch, or Lunr. If you want users to type
`status:active AND created:>=2020-06-01` into a box and have it filter an array,
this is the package.

## Why it exists

Existing JavaScript implementations of the Lucene query language compare dates as
strings. That silently produces wrong results the moment timezone offsets, varying
precision, or non-ISO layouts enter the picture. `siftql` resolves temporal values
to real timestamps and compares them chronologically, and — when a value genuinely
cannot be resolved — fails loudly rather than returning a wrong answer.

Underneath that is a **value-type registry**: `datetime` is not special-cased in
the engine, it is simply a registered type. The same extension point is public, so
you can add `semver`, `ipaddress`, `currency`, or anything else without forking.

## Documentation

Full query-syntax reference, API documentation, extension-point guides, and the
feature comparison table are being written alongside 0.1.0.

## Acknowledgements

The query syntax `siftql` implements is compatible with
[liqe](https://github.com/gajus/liqe) by Gajus Kuizinas, which inspired this
project. `siftql` is an independent implementation written from a specification
rather than derived from liqe's source, with a different internal architecture
(hand-written parser, no parser generator, extensible type registry, chronological
temporal engine).

## License

MIT © [Hussein Abdallah](https://github.com/Hussein-Abdallah)
