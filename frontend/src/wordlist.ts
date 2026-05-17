// Compact bundled wordlist (~700 most-common English words).
// Replace with a larger list (e.g. google-10000-english) for production use.
// Format: lowercase, alphabetized for readability only.

export const WORDS: string[] = [
  "a","about","above","across","act","add","after","again","against","age","ago","agree","air","all","allow","almost","alone","along","already","also","although","always","am","among","an","and","animal","another","answer","any","anything","appear","are","area","arm","around","as","ask","at","away",
  "back","bad","ball","bank","be","beautiful","became","because","become","bed","been","before","began","begin","behind","being","believe","below","best","better","between","big","bit","black","blue","board","boat","body","book","born","both","box","boy","break","bring","brother","brought","build","built","business","but","buy","by",
  "call","came","can","cannot","car","care","carry","case","catch","cause","center","change","check","child","children","city","class","clean","clear","close","cold","color","come","common","company","complete","could","country","course","cover","create","cut",
  "dark","day","dead","deep","did","die","different","do","does","dog","done","door","down","draw","drink","drive","drop","during",
  "each","early","earth","easy","eat","education","eight","either","else","end","enough","even","ever","every","everyone","everything","example","eye","eyes",
  "face","fact","fall","family","far","fast","father","feel","feet","felt","few","field","fight","figure","fill","final","find","fine","fire","first","fish","five","floor","follow","food","foot","for","force","form","found","four","free","friend","from","front","full","fun",
  "game","gave","general","get","girl","give","given","go","God","goes","going","gone","good","got","govern","government","great","green","ground","group","grow",
  "had","hair","half","hand","happen","happy","hard","has","have","he","head","hear","heard","heart","heavy","held","hello","help","her","here","hey","hi","high","him","himself","his","history","hit","hold","home","hope","horse","hot","hour","house","how","however","human","hundred",
  "I","idea","if","important","in","include","increase","indeed","inside","into","is","it","its","itself",
  "job","join","just",
  "keep","kept","key","kid","kind","king","knew","know","known",
  "land","language","large","last","late","later","laugh","law","lay","lead","learn","least","leave","led","left","less","let","letter","life","light","like","line","list","listen","little","live","long","look","lost","lot","love","low",
  "made","main","major","make","man","many","mark","matter","may","maybe","me","mean","meet","member","men","might","mile","mind","mine","minute","miss","money","month","more","morning","most","mother","mountain","mouth","move","much","music","must","my","myself",
  "name","near","need","never","new","news","next","nice","night","nine","no","not","note","nothing","now","number",
  "of","off","offer","office","often","oh","ok","okay","old","on","once","one","only","open","or","order","other","our","out","outside","over","own",
  "page","paper","part","party","pass","past","pay","people","perhaps","person","picture","piece","place","plan","play","please","point","poor","possible","power","present","probably","problem","program","public","pull","push","put",
  "quick","quickly","quite",
  "race","rain","raise","ran","reach","read","ready","real","really","reason","red","remember","return","rich","right","rise","river","road","rock","room","round","run",
  "said","same","sat","saw","say","school","sea","second","see","seem","seen","sense","sent","set","seven","several","shall","she","short","should","show","side","sign","since","sing","sit","six","size","sky","sleep","slow","small","smile","snow","so","some","someone","something","sometimes","song","soon","sort","sound","south","space","speak","special","stand","start","state","stay","step","still","stood","stop","story","strong","study","such","sun","sure","system",
  "table","take","talk","teach","tell","ten","than","thank","that","the","their","them","then","there","these","they","thing","things","think","third","this","those","though","thought","three","through","time","to","today","together","told","too","took","top","toward","town","tree","tried","trip","trouble","true","try","turn","twice","two",
  "under","understand","until","up","upon","us","use","used",
  "very","voice",
  "wait","walk","wall","want","war","warm","was","wash","watch","water","way","we","week","well","went","were","what","when","where","whether","which","while","white","who","whole","why","wide","wife","will","win","wind","window","with","within","without","woman","women","word","work","world","would","write","wrong",
  "yard","year","years","yes","yet","you","young","your","yourself",
];

// Vowel-centered mapping: zone index (0..7) → letters in that zone.
// 0 is the lowest pitch zone, 7 is the highest.
// Design: vowels live in the easy middle (zones 3-4), common consonants
// flank them, rare letters (j/k/q/v/x/z) sit at the extremes.
export const ZONE_LETTERS: string[] = [
  "qxz",   // 0  rare
  "jkv",   // 1  rare
  "bpw",   // 2  uncommon
  "aeh",   // 3  vowels A E + H
  "iou",   // 4  vowels I O U
  "lmn",   // 5  common consonants
  "dfgy",  // 6  varied
  "crst",  // 7  common consonants (high)
];

const LETTER_TO_ZONE: Record<string, number> = {};
ZONE_LETTERS.forEach((letters, i) => {
  for (const c of letters) LETTER_TO_ZONE[c] = i;
});

export function letterToZone(c: string): number | null {
  const z = LETTER_TO_ZONE[c.toLowerCase()];
  return z === undefined ? null : z;
}

/**
 * Given a sequence of zone presses, return up to `limit` candidate words
 * whose letters match (every letter must live in the corresponding zone).
 * Empty sequence → empty array.
 */
export function matchWords(zoneSeq: number[], limit = 5): string[] {
  if (zoneSeq.length === 0) return [];
  const results: string[] = [];
  for (const w of WORDS) {
    if (w.length < zoneSeq.length) continue;
    let ok = true;
    for (let i = 0; i < zoneSeq.length; i++) {
      const c = w[i];
      if (LETTER_TO_ZONE[c] !== zoneSeq[i]) { ok = false; break; }
    }
    if (ok) {
      results.push(w);
      if (results.length >= limit * 4) break; // gather extra, then sort
    }
  }
  // Prefer exact-length matches first, then shortest, then alphabetical
  results.sort((a, b) => {
    const ae = a.length === zoneSeq.length ? 0 : 1;
    const be = b.length === zoneSeq.length ? 0 : 1;
    if (ae !== be) return ae - be;
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : 1;
  });
  return results.slice(0, limit);
}
