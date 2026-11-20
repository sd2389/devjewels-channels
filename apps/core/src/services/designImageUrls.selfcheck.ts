/**
 * Design image URL selfcheck — a listed R2 gallery goes to the store as is.
 * Run: npm run selfcheck:design-images -w @devjewels-channels/core
 */
import { resolveDesignImageUrls } from "./designImageUrls";

let failed = 0;
function check(name: string, ok: boolean): void {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

const listed = [
  "https://r2.example/products/DR-1/Yellow/D_DR-1-1.jpg?sig=a",
  "https://r2.example/products/DR-1/Yellow/H_DR-1-2.jpg?sig=b",
  "https://r2.example/products/DR-1/White/D_DR-1-1.jpg?sig=c",
];

const complete = resolveDesignImageUrls({
  designNo: "DR-1",
  imageUrls: [...listed, listed[0], "not-a-url"],
  thumbnailUrl: "https://r2.example/other-thumb.jpg?sig=z",
  defaultColor: "Yellow",
  imageUrlsComplete: true,
});
check("complete gallery is sent in order, deduped", JSON.stringify(complete) === JSON.stringify(listed));
check("complete gallery never adds CDN guesses", !complete.some((u) => u.includes("cdn.devjewels.com")));

const empty = resolveDesignImageUrls({
  designNo: "DR-2",
  imageUrls: [],
  thumbnailUrl: "https://r2.example/missing.jpg",
  imageUrlsComplete: true,
});
check("design without photos sends no images", empty.length === 0);

const many = resolveDesignImageUrls({
  designNo: "DR-3",
  imageUrls: Array.from({ length: 40 }, (_, i) => `https://r2.example/DR-3-${i}.jpg`),
  imageUrlsComplete: true,
});
check("listed gallery capped at 24", many.length === 24);

const legacy = resolveDesignImageUrls({
  designNo: "DR-4",
  imageUrls: ["https://r2.example/products/DR-4/White/D_DR-4-1.jpg?sig=a"],
  defaultColor: "White",
});
check("without the flag the old CDN expansion still runs", legacy.length > 1 && legacy[0].includes("r2.example"));

if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("designImageUrls selfcheck OK");
