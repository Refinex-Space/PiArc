//! ADR-0102: the market cache keeps what manifests said across search updates, applies the
//! manifest only for the current version, hides theme-only and deprecated packages (a
//! deprecated one shows when asked for by name), filters by kind and words, sorts stably, counts
//! per kind, and retires index rows of older generations.

mod support;

use piarc_store::market::kind;
use piarc_store::{MarketFilter, MarketListing, MarketSort, MarketSync, Store};
use support::TempDir;

fn listing(name: &str, downloads: i64, updated: i64, kw: i64, description: &str) -> MarketListing {
    MarketListing {
        name: name.to_owned(),
        version: "1.0.0".to_owned(),
        description: description.to_owned(),
        keywords: vec!["pi-package".to_owned()],
        publisher: "alice".to_owned(),
        updated_ms: updated,
        downloads_monthly: downloads,
        kw_kinds: kw,
        ..MarketListing::default()
    }
}

fn names(store: &Store, filter: &MarketFilter) -> Vec<String> {
    store
        .market_query(filter)
        .expect("query")
        .0
        .into_iter()
        .map(|r| r.listing.name)
        .collect()
}

fn all() -> MarketFilter {
    MarketFilter {
        limit: 50,
        ..MarketFilter::default()
    }
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "one story over one cache: classify, filter, sort, update"
)]
fn the_cache_classifies_filters_and_sorts() {
    let dir = TempDir::new("market");
    let mut store = Store::open(&dir.path().join("core.sqlite"), 0).expect("store");
    store
        .market_put(
            &[
                listing("pi-ext", 300, 1, kind::EXTENSION, "MCP adapter 适配"),
                listing("pi-skill", 100, 3, kind::SKILL, "Review skills"),
                listing("pi-mixed", 100, 2, 0, "Prompts and a theme"),
                listing("pi-theme", 900, 9, kind::THEME, "Dark theme"),
                listing("pi-unknown", 50, 5, 0, "Something 100%_done"),
            ],
            Some(1),
            10,
        )
        .expect("put");
    // pi-mixed: the manifest says prompts and a theme; pi-theme: the manifest agrees.
    store
        .market_set_manifest("pi-mixed", "1.0.0", kind::PROMPT | kind::THEME, false)
        .expect("manifest");
    store
        .market_set_manifest("pi-theme", "1.0.0", kind::THEME, false)
        .expect("manifest");

    // Theme-only packages never show; ties sort by name.
    assert_eq!(
        names(&store, &all()),
        ["pi-ext", "pi-mixed", "pi-skill", "pi-unknown"]
    );
    let updated = MarketFilter {
        sort: MarketSort::Updated,
        ..all()
    };
    assert_eq!(
        names(&store, &updated),
        ["pi-unknown", "pi-skill", "pi-mixed", "pi-ext"]
    );
    let prompts = MarketFilter {
        kind: Some(kind::PROMPT),
        ..all()
    };
    assert_eq!(names(&store, &prompts), ["pi-mixed"]);
    let counts = store.market_counts(&all()).expect("counts");
    assert_eq!(
        (counts.all, counts.extension, counts.skill, counts.prompt),
        (4, 1, 1, 1)
    );

    // Words match name, description, keywords or publisher; LIKE wildcards are literal.
    let words = |w: &[&str]| MarketFilter {
        words: w.iter().map(|s| (*s).to_owned()).collect(),
        ..all()
    };
    assert_eq!(names(&store, &words(&["适配"])), ["pi-ext"]);
    assert_eq!(names(&store, &words(&["review", "alice"])), ["pi-skill"]);
    assert_eq!(names(&store, &words(&["100%_"])), ["pi-unknown"]);
    assert_eq!(names(&store, &words(&["0%"])), ["pi-unknown"]);
    assert!(names(&store, &words(&["1_0"])).is_empty());

    // A new version: the old manifest no longer decides, the keywords do until it is read.
    let mut next = listing("pi-mixed", 100, 2, kind::SKILL, "Prompts and a theme");
    next.version = "2.0.0".to_owned();
    store.market_put(&[next], None, 11).expect("put");
    assert_eq!(names(&store, &prompts), Vec::<String>::new());
    assert_eq!(
        store.market_unclassified(10).expect("unclassified")[0].0,
        "pi-ext"
    );
    assert!(
        store
            .market_unclassified(10)
            .expect("unclassified")
            .contains(&("pi-mixed".to_owned(), "2.0.0".to_owned()))
    );

    // Deprecated: hidden, unless asked for by name.
    store
        .market_set_manifest("pi-skill", "1.0.0", kind::SKILL, true)
        .expect("manifest");
    assert!(!names(&store, &all()).contains(&"pi-skill".to_owned()));
    let named = MarketFilter {
        names: Some(vec!["pi-skill".to_owned()]),
        deprecated_named: Some("pi-skill".to_owned()),
        ..all()
    };
    assert_eq!(names(&store, &named), ["pi-skill"]);
    let row = store
        .market_package("pi-skill")
        .expect("row")
        .expect("present");
    assert!(row.deprecated);
    assert_eq!(row.kinds(), kind::SKILL);
}

#[test]
fn a_new_index_generation_retires_older_rows_but_keeps_them_cached() {
    let dir = TempDir::new("market gen");
    let mut store = Store::open(&dir.path().join("core.sqlite"), 0).expect("store");
    store
        .market_put(
            &[listing("a", 1, 1, 0, ""), listing("b", 2, 2, 0, "")],
            Some(1),
            1,
        )
        .expect("first");
    store
        .market_put(&[listing("searched", 1, 1, 0, "")], None, 1)
        .expect("search");
    store
        .market_put(&[listing("a", 5, 1, 0, "")], Some(2), 2)
        .expect("second");
    store.market_end_index(2).expect("end");
    let indexed: Vec<(String, bool)> = ["a", "b", "searched"]
        .iter()
        .map(|n| {
            let row = store.market_package(n).expect("row").expect("present");
            (row.listing.name, row.indexed)
        })
        .collect();
    assert_eq!(
        indexed,
        [
            ("a".into(), true),
            ("b".into(), false),
            ("searched".into(), false)
        ]
    );
    assert_eq!(store.market_classified().expect("classified"), (0, 1));
    let sync = MarketSync {
        generation: 2,
        state: "idle".into(),
        done: 2,
        total: 2,
        ok_ms: 99,
        ..MarketSync::default()
    };
    store.set_market_sync(&sync).expect("sync");
    assert_eq!(store.market_sync().expect("read"), sync);
}
