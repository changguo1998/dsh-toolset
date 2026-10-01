/**
 * 自动别名词表与取词（F1「会话别名自动生成」）：内置 ≤8 字符 ASCII 名词 / 名字 +
 * 类型前缀（ui- / sub-）+ 随机取词。与插件实现（index.ts）分开，便于换风格 / 扩表。
 * 测试强制：词长 ≤8、`[A-Za-z]`、非保留字、无重复。
 */

/** 词表（2026-10-01 扩表）：动物 / 植物 / 矿物与岩石 / 天体 / 天气 / 自然地貌；全部名词、≤8 字符。 */
export const AUTO_ALIAS_WORDS = [
  // 动物
  "otter",
  "badger",
  "beaver",
  "bison",
  "cobra",
  "condor",
  "cricket",
  "dolphin",
  "donkey",
  "eagle",
  "egret",
  "falcon",
  "ferret",
  "finch",
  "gazelle",
  "gecko",
  "hare",
  "heron",
  "ibis",
  "impala",
  "jackal",
  "jaguar",
  "koala",
  "lemur",
  "lobster",
  "lynx",
  "magpie",
  "marten",
  "moose",
  "narwhal",
  "newt",
  "ocelot",
  "okapi",
  "osprey",
  "panda",
  "parrot",
  "puffin",
  "quail",
  "quokka",
  "rabbit",
  "raven",
  "rhino",
  "robin",
  "salmon",
  "seal",
  "stork",
  "tapir",
  "toucan",
  "urchin",
  "viper",
  "vole",
  "vulture",
  "walrus",
  "weasel",
  "weevil",
  "wombat",
  "xerus",
  "yak",
  "zebra",
  // 植物
  "alder",
  "basil",
  "birch",
  "cedar",
  "clover",
  "fern",
  "hazel",
  "iris",
  "lotus",
  "maple",
  "moss",
  "orchid",
  "reed",
  "sage",
  "thistle",
  "willow",
  // 矿物 / 岩石
  "agate",
  "amber",
  "basalt",
  "beryl",
  "flint",
  "garnet",
  "geode",
  "granite",
  "jade",
  "jasper",
  "marble",
  "mica",
  "obsidian",
  "onyx",
  "opal",
  "quartz",
  "slate",
  "topaz",
  "zircon",
  // 天体
  "atlas",
  "aurora",
  "comet",
  "juno",
  "luna",
  "lyra",
  "meteor",
  "mira",
  "nebula",
  "nova",
  "orion",
  "phobos",
  "pluto",
  "pulsar",
  "quasar",
  "rhea",
  "sirius",
  "titan",
  "umbra",
  "vega",
  "virgo",
  "zenith",
  // 天气
  "blizzard",
  "breeze",
  "cloud",
  "drizzle",
  "fog",
  "frost",
  "gale",
  "hail",
  "mist",
  "rain",
  "shower",
  "sleet",
  "snow",
  "storm",
  "tempest",
  "thunder",
  "wind",
  // 自然地貌
  "brook",
  "creek",
  "delta",
  "dune",
  "ember",
  "fjord",
  "glacier",
  "grove",
  "islet",
  "lagoon",
  "meadow",
  "reef",
  "ridge",
  "tide",
  "valley",
] as const;

/** 自动别名重试上限（仅 `alias_taken` 重试）。 */
export const AUTO_ALIAS_TRIES = 8;

/**
 * 按会话类型取别名前缀（F1）：子代理会话 `sub-`（`header.origin === "subagent"`
 * 或 `delegationDepth > 0`），其余（用户启动会话）`ui-`。宽容读取，缺字段按用户会话。
 */
export function aliasPrefixFor(session: unknown): "ui-" | "sub-" {
  const header = (
    session as {
      header?: { origin?: unknown; delegationDepth?: unknown };
    } | null
  )?.header;
  if (header !== null && header !== undefined) {
    if (header.origin === "subagent") return "sub-";
    const depth = header.delegationDepth;
    if (typeof depth === "number" && depth > 0) return "sub-";
  }
  return "ui-";
}

/** 取一个自动别名（前缀 + 随机词；随机源可注入，便于测试）。 */
export function pickAutoAlias(
  prefix: "ui-" | "sub-",
  random: () => number = Math.random,
): string {
  const idx = Math.min(
    AUTO_ALIAS_WORDS.length - 1,
    Math.max(0, Math.floor(random() * AUTO_ALIAS_WORDS.length)),
  );
  return `${prefix}${AUTO_ALIAS_WORDS[idx]}`;
}
