/**
 * data.js — サンプルデータ定義
 * セキュリティ方針: APIキー不使用。
 * データはすべて LocalStorage に保存し、ブラウザ内で完結します。
 */

const SAMPLE_ITEMS = [
  {
    id: "sample-1",
    itemName: "いかめし",
    storeName: "函館朝市 駅二市場",
    region: "北海道・東北",
    category: "惣菜",
    rating: 5,
    comment: "もち米にタレが染み込んでいて最高！函館に来たら必ず買って帰る一品です。",
    photoDataUrl: null,
    createdAt: "2025-08-12T10:30:00.000Z"
  },
  {
    id: "sample-2",
    itemName: "ずんだ餅",
    storeName: "仙台三越 地下食品売り場",
    region: "北海道・東北",
    category: "銘菓",
    rating: 5,
    comment: "枝豆の甘さと滑らかな食感がやみつき。お土産はこれ一択。",
    photoDataUrl: null,
    createdAt: "2025-09-01T14:00:00.000Z"
  },
  {
    id: "sample-3",
    itemName: "揚げかまぼこ",
    storeName: "マルナカ 松山東店",
    region: "中国・四国",
    category: "惣菜",
    rating: 4,
    comment: "揚げたてでサクッフワッ。じゃこ天との食べ比べが楽しい。",
    photoDataUrl: null,
    createdAt: "2025-09-18T12:10:00.000Z"
  },
  {
    id: "sample-4",
    itemName: "あまおうジャムパン",
    storeName: "デイリーヤマザキ 博多駅前店",
    region: "九州・沖縄",
    category: "銘菓",
    rating: 4,
    comment: "苺の風味がしっかり。九州限定なのが惜しすぎる！",
    photoDataUrl: null,
    createdAt: "2025-10-05T08:45:00.000Z"
  },
  {
    id: "sample-5",
    itemName: "みそカツ串",
    storeName: "ぎゅーとら 津久井店",
    region: "中部・東海",
    category: "惣菜",
    rating: 5,
    comment: "名古屋飯の本場でローカルスーパーのみそカツを食べるのが旅の定番になった。",
    photoDataUrl: null,
    createdAt: "2025-10-22T11:20:00.000Z"
  },
  {
    id: "sample-6",
    itemName: "551 豚まん",
    storeName: "阪急梅田駅 構内売店",
    region: "近畿",
    category: "惣菜",
    rating: 5,
    comment: "「551がある時ない時」の格言は本物。あの日食べた豚まんは忘れられない。",
    photoDataUrl: null,
    createdAt: "2025-11-03T16:00:00.000Z"
  }
];
