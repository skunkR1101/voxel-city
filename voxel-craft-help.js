/* voxel-craft-help.js  (v1)  使い方・ヘルプ（浮かぶ説明書）
 *
 * 入口：タイトル画面の「設定」の上、ゲーム内の設定画面の一番上の「使い方・ヘルプ」ボタン。
 * 表示：画面の上に浮かぶパネル。ドラッグで動かせ、作業しながら見られます。機能ごとのタブで切り替え。
 * 言語：文章は言語ごとのデータ（LANG_TEXT）。新しい言語は、同じ形のデータを1つ足すだけで追加できます。
 *   今は 日本語（ja）と英語（en）。ブラウザの言語で最初の言語を決め、画面の選択で変えられます（記憶されます）。
 *
 * 読み込み：voxel-craft-ext.js の読み込み一覧に入っています。
 */
(function () {
  'use strict';
  if (window.VoxelHelp) return;

  const LANG_KEY = 'voxelcraft_help_lang_v1';
  const LANG_NAMES = { ja: '日本語', en: 'English' };

  // ============================================================
  // 図（文字は言語ごとの文章から入れる）
  // ============================================================
  // 横に並べた流れ図
  function flowSvg(labels) {
    const w = 128, gap = 26, h = 56;
    const W = labels.length * w + (labels.length - 1) * gap;
    let s = `<svg viewBox="0 0 ${W} ${h}" width="100%" role="img" style="max-width:${W}px">`;
    labels.forEach((t, i) => {
      const x = i * (w + gap);
      s += `<rect x="${x}" y="6" width="${w}" height="44" rx="10" fill="#e8f1ff" stroke="#3b6fb6" stroke-width="2"/>`;
      s += `<text x="${x + w / 2}" y="34" text-anchor="middle" font-size="13" fill="#1d3b63" font-family="sans-serif">${t}</text>`;
      if (i < labels.length - 1) {
        const ax = x + w + 3;
        s += `<path d="M${ax} 28 L${ax + gap - 8} 28" stroke="#3b6fb6" stroke-width="2"/><path d="M${ax + gap - 8} 22 L${ax + gap - 1} 28 L${ax + gap - 8} 34" fill="none" stroke="#3b6fb6" stroke-width="2"/>`;
      }
    });
    return s + '</svg>';
  }
  // キーの配置図（主要なキーを、位置どおりに並べる）。1キー＝72px。キー名（上）と説明（下）の2行
  function keysSvg(keys) {
    const U = 72, W = 6 * U, H = 4 * U;
    let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" style="max-width:${W}px">`;
    for (const k of keys) {
      const x = k.x * U + 2, y = k.y * U + 2, w = (k.w || 1) * U - 4, h = U - 4;
      const fill = k.on ? '#ffe49a' : '#f3f6fb';
      s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${fill}" stroke="#5a6c86" stroke-width="1.5"/>`;
      s += `<text x="${x + w / 2}" y="${y + 27}" text-anchor="middle" font-size="14" font-weight="bold" fill="#1d2b3f" font-family="sans-serif">${k.k}</text>`;
      if (k.d) s += `<text x="${x + w / 2}" y="${y + 47}" text-anchor="middle" font-size="11" fill="#33415c" font-family="sans-serif">${k.d}</text>`;
    }
    return s + '</svg>';
  }
  // キーの配置（WASD・Space など）
  const KEY_LAYOUT = {
    ja: [
      { x: 1, y: 0, k: 'W', d: '前' }, { x: 0, y: 1, k: 'A', d: '左' }, { x: 1, y: 1, k: 'S', d: '後' }, { x: 2, y: 1, k: 'D', d: '右' },
      { x: 4, y: 0, k: 'Q', d: '視点', on: true }, { x: 5, y: 0, k: 'E', d: '持ち物' },
      { x: 0, y: 2, k: 'Shift', d: '下降' }, { x: 0, y: 3, k: 'Ctrl', d: 'ダッシュ' },
      { x: 2, y: 2, w: 3, k: 'Space', d: 'ジャンプ・飛行', on: true }, { x: 4, y: 2, k: 'F', d: '飛行' }, { x: 5, y: 2, k: 'L', d: '影' },
      { x: 4, y: 3, k: 'T', d: 'チャット' }, { x: 5, y: 3, k: 'Esc', d: '一時停止' }
    ],
    en: [
      { x: 1, y: 0, k: 'W', d: 'Fwd' }, { x: 0, y: 1, k: 'A', d: 'Left' }, { x: 1, y: 1, k: 'S', d: 'Back' }, { x: 2, y: 1, k: 'D', d: 'Right' },
      { x: 4, y: 0, k: 'Q', d: 'View', on: true }, { x: 5, y: 0, k: 'E', d: 'Bag' },
      { x: 0, y: 2, k: 'Shift', d: 'Down' }, { x: 0, y: 3, k: 'Ctrl', d: 'Dash' },
      { x: 2, y: 2, w: 3, k: 'Space', d: 'Jump / Fly', on: true }, { x: 4, y: 2, k: 'F', d: 'Fly' }, { x: 5, y: 2, k: 'L', d: 'Shade' },
      { x: 4, y: 3, k: 'T', d: 'Chat' }, { x: 5, y: 3, k: 'Esc', d: 'Pause' }
    ]
  };

  // 文章（言語ごと）
  // 形：{ title, cats:[{ id, tab, title, intro, sections:[{h, items:[...]}], diagram }] }
  // ============================================================
  const LANG_TEXT = {
    ja: {
      ui: { title: '使い方・ヘルプ', close: '閉じる', min: '小さく', lang: '言語', drag: 'ここをドラッグして動かせます' },
      cats: [
        {
          id: 'start', tab: 'はじめに', title: 'はじめに',
          intro: 'ボクセルクラフトは、ブロックで街や乗り物を作り、ほかの人と同じワールドで遊べる自由な都市開発ゲームです。',
          sections: [
            { h: '始め方', items: ['「クリックして開始」で、ワールドに入ります。', '操作の一覧は、この説明書の「基本操作」をご覧ください。', 'スマホでも遊べます。画面の操作は「基本操作」の最後にあります。'] },
            { h: '作ったものの保存', items: ['作ったものは、ブラウザの中に保存されます（同じブラウザ・同じ端末で続きができます）。', '別の端末で続けたいときは、ワールドのファイルを書き出して持ち運びます（ワールドのメニューから行えます）。'] },
            { h: '説明書の見方', items: ['上のタブで、機能ごとに切り替えます。', 'パネルは、ドラッグで好きな場所に動かせます。作業しながら開いたままにできます。', '言語は、このパネルの右上で切り替えられます。'] }
          ]
        },
        {
          id: 'basic', tab: '基本操作', title: '基本操作',
          intro: 'パソコンはキーボードとマウス、スマホは画面をタッチして操作します。',
          diagram: 'keys',
          sections: [
            { h: 'キーボード（パソコン）', items: ['WASD：移動（同じキーを素早く2回押すとダッシュ）', 'マウス：視点を動かす', 'スペース：ジャンプ（2回押すと飛行ON・着陸）　Shift：下降　Ctrl：ダッシュ', '左クリック：壊す　右クリック：置く', '1〜9キー・マウスホイール：持ち物（下のバーのブロック）を選ぶ', 'E：持ち物（バッグ）を開く　Q：視点切替（一人称→三人称後方→三人称前方）', 'F：飛行切替　L：影（シェーダー）切替　Esc：一時停止・メニュー　Tab：マウスカーソルを出す（ボタンを押すとき）'] },
            { h: 'スマホ・タブレット', items: ['左半分をドラッグ：移動　右半分をドラッグ：視点', '右半分をタップ：置く　右半分を長押し：壊す', 'ジャンプを2回タップで飛行ON・着陸', '「視点」「ダッシュ」ボタンがあります'] }
          ]
        },
        {
          id: 'blocks', tab: 'ブロック', title: 'ブロックと置き方',
          intro: '持ち物のブロックを選んで、置いたり壊したりします。細かい位置合わせや、斜めのブロックも作れます。',
          sections: [
            { h: '格子（グリッド）', items: ['画面のクイックバーで、格子の細かさを 1.0 / 0.5 / 0.25 マスから選べます（キーは「]」「[」）。', '細かい格子にすると、半分の位置にもブロックを置けます。'] },
            { h: '傾き（斜めのブロック）', items: ['クイックバーの「傾き」で、ブロックを斜めに置けます（キーは「=」）。', '角度は「.」キーで切り替えられます。'] },
            { h: '範囲の操作（ワールドエディット風）', items: ['範囲選択の道具で2点を選ぶと、その範囲を操作できます。', 'コピー・貼り付けの向きは、Y（回転）・U（左右反転）・I（前後反転）で切り替えます。', 'Z：ひとつ戻す　R：元に戻す　V：回転　C：色を変える　G：色のパネル'] }
          ]
        },
        {
          id: 'custom', tab: 'カスタム', title: 'カスタムブロック',
          intro: '自分の絵やモデル（OBJ）を、ブロックとして登録できます。',
          sections: [
            { h: '種類', items: ['絵のブロック：PNGの絵を、立方体に貼ります。色を付けられるものもあります。', 'モデルのブロック：OBJ（Blockbenchで作ったものなど）を、テクスチャ付きで置けます。', '音のブロック：置いたときや壊したときの音を付けられます。'] },
            { h: '置く位置', items: ['モデルの置き方は、「中心」（ブロックの真ん中に合わせる）か、「Blockbench位置のまま」（作ったときの位置どおり）から選べます。', '線路・道路・カスタムブロックのどれにも、この選び方があります。'] }
          ]
        },
        {
          id: 'road', tab: '道路・線路', title: '道路と線路',
          intro: '道路や線路を敷くと、ほかの人にもリアルタイムで同じように見えます。',
          sections: [
            { h: '敷き方', items: ['K：道路モード　J：線路モード', 'タップ（クリック）で、始点と終点を決めて敷きます。', 'M：途中の点を追加（カーブを作るとき）', 'Backspace：ひとつ戻す（敷いたものを消します）'] },
            { h: '見た目', items: ['道路・線路は、形と位置が保存されます。', '模型の線路・道路も、配置の選び方（中心・Blockbench位置のまま）で置けます。'] }
          ]
        },
        {
          id: 'train', tab: '列車', title: '列車（トレインエディター）',
          intro: '列車の車両を、模型（OBJ）から作って運行させられます。',
          sections: [
            { h: '車両の作り方', items: ['N：列車のパネルを開きます（車両の一覧、新規作成）。', '車両の長さは1両ごとに変えられます（初期値は20m）。', 'OBJ模型を読み込み、部品（ドア・幕・ライトなど）を選んでアニメーションを付けられます。', '当たり判定（壁・床・座席の位置）も、透明な箱で設定できます。', '加速音・減速音は、VVVFの音を120分割で読み込めます。'] },
            { h: '運行', items: ['B：列車の運行を開始・停止します。', '車両は、保存したものが自動で反映されます。'] }
          ]
        },
        {
          id: 'dia', tab: 'ダイヤ・駅', title: 'ダイヤ・駅・路線',
          intro: '路線と駅を設定して、列車を自動で走らせます。',
          sections: [
            { h: 'ダイヤ（路線）', items: ['O：ダイヤ編集を開きます。種別・編成・路線ごとの経路を決めます。', 'タップ2回で、始点と終点を決めて経路を登録できます（カーブにも対応）。', 'M：途中のマーカー（車内放送・警笛）を置けます。'] },
            { h: '駅', items: ['P：駅の設定を開きます。', 'ドアを開ける側、発車メロディー、扉を閉めるときの放送、接近放送、退避・待機、次の駅までの速度、折り返しを設定します。', '列車は「停車 → ドアが開く → 放送 → ドアが閉まる → 発車」を自動で行います。'] }
          ]
        },
        {
          id: 'traffic', tab: '車・バス', title: '車とバス',
          intro: '道路の上を、車やバスが自動で走ります。',
          sections: [
            { h: '出現地点', items: ['出現地点（車が出てくる入り口）ごとに、出す間隔と、車・バスの割合を決められます。', '地点ごとに、バスを出すか（オン・オフ）も選べます。'] },
            { h: '車を追加する', items: ['「車・出現の設定」から、自分の車の模型を登録できます。', 'この車を「バス」として登録するときは、「バス」にチェックを入れます。', 'ブロックで作った車も、「ブロックで作った車・バスを追加」から登録できます（下の「ブロックで乗り物を作る」を参照）。'] },
            { h: 'バス専用ライン', items: ['経路を引くとき、「バスライン」をONにすると、その区間はバス専用になります。', 'バスは専用ラインを優先して選びます。一般の車は専用ラインを通りません。'] }
          ]
        },
        {
          id: 'edit', tab: 'エディット', title: '本格エディットモード',
          intro: '作ったブロックや傾きブロックを、あとから動かしたり、大きさや向きを変えたりできます。',
          diagram: 'flow:edit',
          sections: [
            { h: '始め方', items: ['設定の「エディットモードを使う」をONにします。', '「画面上に切り替えボタンを表示」をONにすると、画面左上に「エディット」ボタンが出ます。'] },
            { h: '操作', items: ['ブロックをタップして選びます（黄色い枠で示されます）。', '矢印キー：左右・奥手前に動かす　PageUp・PageDown：上下に動かす', 'パネルのボタン：拡大・縮小、X・Y・Z軸の回転（15°・45°・90°）、複製、削除', '「スナップ」をONにすると、近くのブロックの四隅に合わせられます。'] },
            { h: '保存と取り消し', items: ['傾きブロックの編集は、「エディット作業を保存」を押すまで、ほかの人には反映されません。「取り消し」で元に戻ります。', '標準のブロックの移動や削除は、ふだんの置き方・壊し方と同じく、すぐにワールドに反映されます（取り消しで戻せます）。'] }
          ]
        },
        {
          id: 'convert', tab: 'ブロックで乗り物', title: 'ブロックで乗り物を作る',
          intro: '作ったブロックを、そのまま車・バス・電車にできます。',
          diagram: 'flow:convert',
          sections: [
            { h: '作り方', items: ['車・電車の設定から「ブロックで作った車・バスを追加」（電車は「ブロックで作った車両を追加」）を押します。', 'パネルを閉じて、ステッキで2点を選び、部品名（例：本体・ドア）を入れて「この範囲を部品に追加」を押します。部品は何個でも追加できます。', '種類（車・バス・電車）・名前・長さを決め、「車両を作る」を押します。'] },
            { h: '残るもの', items: ['色・テクスチャ・発光するブロック・半透明のガラスは、そのまま残ります。', 'モデル（OBJ）のブロックも取り込めます。', '電車では、部品名を選んでドアなどのアニメーションを付けられます。当たり判定や座席は、作ったあとに編集画面で設定します。'] }
          ]
        },
        {
          id: 'economy', tab: '端末・経済', title: 'マイ端末と経済',
          intro: '道具の「マイ端末」で、設定・経済・路線図のアプリを使えます。',
          sections: [
            { h: 'マイ端末', items: ['道具カテゴリの「マイ端末」を持つと、端末の画面が開きます。', '画面の中のアプリ（設定・経済・路線図）を選んで使います。', '縦にスクロールできます（スマホも同じ）。'] },
            { h: '経済', items: ['会社の一覧、会社の起業、スカウト（人を誘う）ができます。', '利益地点を設定すると、そこを車が通ったときに会社へ収益が入ります（上限はありません）。', '収益・貯金の確認、送金ができます。'] },
            { h: '路線図', items: ['路線図のアプリで、駅と路線を描けます。描くだけの図です。', '会社ごとに作られ、社長と管理の人が編集できます。'] }
          ]
        },
        {
          id: 'multi', tab: 'チャット・通信', title: 'チャットと一緒に遊ぶ',
          intro: '部屋に参加すると、ほかの人と同じワールドを一緒に作れます。',
          sections: [
            { h: '一緒に遊ぶ', items: ['部屋に参加すると、ブロック・傾きブロック・道路・線路・列車・ダイヤなどが、リアルタイムで同じように見えます。', '車両の保存や、経路の変更も、ほかの人に届きます。'] },
            { h: 'チャット', items: ['T：チャットを開きます（部屋に参加しているときに使えます）。', '文字、画像、GIF（150KB以上も可）、リンクを送れます。', '送られた画像やGIFは、タップ・クリックでプレビューできます。'] }
          ]
        },
        {
          id: 'settings', tab: '設定', title: '設定',
          intro: '画面の見え方や、遊びやすさを決めます。',
          sections: [
            { h: '主な設定', items: ['視野：広さを変えられます。', '画面上の全てのボタンを非表示：ボタンを消して、景色だけを見られます。', '描画距離：遠くまで描くかどうかを決めます（重いときは短くします）。', '影（シェーダー）：L キーでも切り替えられます。', '格子・傾き・エディットのボタン：画面上に出すかどうかを選べます。'] },
            { h: '使い方', items: ['設定の一番上の「使い方・ヘルプ」から、この説明書を開けます。', 'タイトル画面の「使い方・ヘルプ」からも開けます。'] }
          ]
        }
      ]
    },
    en: {
      ui: { title: 'Help & Guide', close: 'Close', min: 'Minimize', lang: 'Language', drag: 'Drag here to move this window' },
      cats: [
        {
          id: 'start', tab: 'Start', title: 'Getting started',
          intro: 'Voxel Craft is a free city-building game. Build cities and vehicles from blocks, and share the same world with other players.',
          sections: [
            { h: 'Starting', items: ['Click "Click to start" to enter the world.', 'See "Basic controls" for the full key list.', 'It works on phones and tablets too. Touch controls are in "Basic controls".'] },
            { h: 'Saving your work', items: ['Your work is saved in your browser (you can continue in the same browser and device).', 'To continue on another device, export the world file from the world menu.'] },
            { h: 'Using this guide', items: ['Switch topics with the tabs at the top.', 'Drag the panel anywhere, so you can keep it open while you build.', 'Change the language at the top right of this panel.'] }
          ]
        },
        {
          id: 'basic', tab: 'Controls', title: 'Basic controls',
          intro: 'On a PC, use the keyboard and mouse. On a phone or tablet, use touch.',
          diagram: 'keys',
          sections: [
            { h: 'Keyboard (PC)', items: ['WASD: move (tap the same key twice quickly to dash)', 'Mouse: look around', 'Space: jump (press twice to toggle flight; land by pressing again)  Shift: go down  Ctrl: dash', 'Left click: break  Right click: place', '1–9 keys / mouse wheel: choose a block from the hotbar', 'E: open your bag  Q: change camera view (first person → third person back → third person front)', 'F: toggle flight  L: toggle shader (shadows)  Esc: pause / menu  Tab: show the mouse cursor (to press on-screen buttons)'] },
            { h: 'Phone / tablet', items: ['Drag the left half: move   Drag the right half: look', 'Tap the right half: place   Long-press the right half: break', 'Tap jump twice to fly; tap again to land', 'Use the "View" and "Dash" buttons'] }
          ]
        },
        {
          id: 'blocks', tab: 'Blocks', title: 'Blocks and placing',
          intro: 'Choose a block from your items to place or break it. You can also make fine positions and tilted blocks.',
          sections: [
            { h: 'Grid', items: ['In the quick bar, choose the grid size: 1.0 / 0.5 / 0.25 blocks (keys "]" and "[").', 'With a fine grid you can place blocks at half positions.'] },
            { h: 'Tilt (diagonal blocks)', items: ['Use "Tilt" in the quick bar to place blocks at an angle (key "=").', 'Change the angle step with the "." key.'] },
            { h: 'Area tools (world-edit style)', items: ['Choose two points with the area-select tool to operate on that area.', 'Paste orientation: Y (rotate), U (mirror left-right), I (mirror front-back).', 'Z: undo one step  R: reset  V: rotate  C: recolor  G: color panel'] }
          ]
        },
        {
          id: 'custom', tab: 'Custom', title: 'Custom blocks',
          intro: 'You can register your own pictures and models (OBJ) as blocks.',
          sections: [
            { h: 'Types', items: ['Picture blocks: put a PNG picture on a cube. Some can be colored.', 'Model blocks: place an OBJ model (for example, made in Blockbench) with its texture.', 'Sound blocks: add sounds for placing and breaking.'] },
            { h: 'Placement', items: ['For models, choose "Center" (aligned to the middle of the block) or "Blockbench position" (as originally made).', 'Rails, roads and custom blocks all have this choice.'] }
          ]
        },
        {
          id: 'road', tab: 'Roads & rails', title: 'Roads and rails',
          intro: 'Roads and rails you lay appear the same for other players in real time.',
          sections: [
            { h: 'Laying', items: ['K: road mode   J: rail mode', 'Click to set the start and end points.', 'M: add a middle point (for curves)', 'Backspace: undo one piece'] },
            { h: 'Appearance', items: ['Shape and position are saved.', 'Model-based roads and rails use the same placement choice ("Center" or "Blockbench position").'] }
          ]
        },
        {
          id: 'train', tab: 'Trains', title: 'Trains (train editor)',
          intro: 'Make train cars from OBJ models and run them.',
          sections: [
            { h: 'Making a car', items: ['N: open the train panel (car list and new car).', 'You can change the length of each car (default 20 m).', 'Load an OBJ model, pick parts (doors, signs, lights) and set their animations.', 'Set collision (walls, floor, seats) with invisible boxes.', 'Acceleration and braking sounds can be loaded as VVVF audio split into 120 parts.'] },
            { h: 'Running', items: ['B: start / stop train operation.', 'Saved cars are applied automatically.'] }
          ]
        },
        {
          id: 'dia', tab: 'Timetable & stations', title: 'Timetable, stations and lines',
          intro: 'Set lines and stations so trains run automatically.',
          sections: [
            { h: 'Timetable (lines)', items: ['O: open the timetable editor. Set types, formations and routes for each line.', 'Tap twice to set the start and end of a route (curves are supported).', 'M: place markers (in-train announcements, horn).'] },
            { h: 'Stations', items: ['P: open station settings.', 'Set the door side, departure melody, closing announcement, approach announcement, waiting/passing, speed to the next station, and turnback.', 'Trains automatically do: stop → doors open → announcement → doors close → depart.'] }
          ]
        },
        {
          id: 'traffic', tab: 'Cars & buses', title: 'Cars and buses',
          intro: 'Cars and buses drive on the roads automatically.',
          sections: [
            { h: 'Spawn points', items: ['For each spawn point (where cars come out), set the interval and the share of cars and buses.', 'For each point, you can turn buses on or off.'] },
            { h: 'Adding a car', items: ['In "Car / spawn settings", register your own car model.', 'Check "Bus" to register it as a bus.', 'Cars made from blocks can be added with "Add block-built car / bus" (see "Blocks to vehicle").'] },
            { h: 'Bus lanes', items: ['When drawing a route, turn on "Bus lane" to make that section bus-only.', 'Buses prefer bus-only lanes. General cars do not use them.'] }
          ]
        },
        {
          id: 'edit', tab: 'Edit mode', title: 'Full edit mode',
          intro: 'Move, resize, rotate, copy and delete blocks after you have built them.',
          diagram: 'flow:edit',
          sections: [
            { h: 'Turning it on', items: ['In Settings, turn on "Use edit mode".', 'Turn on "Show switch button on screen" to get an "Edit" button at the top left.'] },
            { h: 'Controls', items: ['Tap a block to select it (a yellow frame shows it).', 'Arrow keys: move left/right/front/back.  PageUp / PageDown: move up/down.', 'Panel buttons: scale up/down, rotate around X / Y / Z (15°, 45°, 90°), copy, delete.', 'Turn on "Snap" to align with the corners of nearby blocks.'] },
            { h: 'Saving and canceling', items: ['Edits to tilted and custom blocks are shared with others only after you press "Save edit". "Cancel" undoes them.', 'Moving or deleting standard blocks takes effect right away, like normal placing and breaking (you can undo it).'] }
          ]
        },
        {
          id: 'convert', tab: 'Blocks to vehicle', title: 'Making vehicles from blocks',
          intro: 'Turn the blocks you built into a car, bus or train.',
          diagram: 'flow:convert',
          sections: [
            { h: 'How', items: ['In the car or train menu, press "Add block-built car / bus" (for trains: "Add block-built car").', 'Close the panel, choose two points with the tool, enter a part name (for example, body or door), and press "Add this area as a part". You can add as many parts as you like.', 'Choose the type (car, bus, train), a name and a length, then press "Make vehicle".'] },
            { h: 'What is kept', items: ['Colors, textures, glowing blocks and transparent glass are kept.', 'OBJ model blocks are included too.', 'For trains, pick part names to give doors and other parts animations. Collision and seats are set in the editor afterwards.'] }
          ]
        },
        {
          id: 'economy', tab: 'Phone & economy', title: 'My Device and the economy',
          intro: 'The "My Device" item opens apps for settings, economy and route maps.',
          sections: [
            { h: 'My Device', items: ['Hold the "My Device" item from the tools category to open the screen.', 'Choose an app inside (Settings, Economy, Route map).', 'You can scroll up and down (the same on phones).'] },
            { h: 'Economy', items: ['View the company list, found a company, and scout people.', 'Set profit points: when a car passes one, the company earns money (no upper limit).', 'Check revenue and savings, and send money.'] },
            { h: 'Route map', items: ['Draw stations and lines in the route-map app. It is a drawing for reference.', 'Each company has its own map. The president and managers can edit it.'] }
          ]
        },
        {
          id: 'multi', tab: 'Chat & multiplayer', title: 'Playing together',
          intro: 'Join a room to build the same world with other players.',
          sections: [
            { h: 'Playing together', items: ['In a room, blocks, tilted blocks, roads, rails, trains and timetables show up the same for everyone in real time.', 'Saved cars and changed routes are also sent to others.'] },
            { h: 'Chat', items: ['T: open chat (available while in a room).', 'Send text, pictures, GIFs (even over 150 KB) and links.', 'Tap or click a received picture or GIF to preview it.'] }
          ]
        },
        {
          id: 'settings', tab: 'Settings', title: 'Settings',
          intro: 'Adjust how the screen looks and how comfortable it is to play.',
          sections: [
            { h: 'Main settings', items: ['Field of view: change how wide the view is.', 'Hide all on-screen buttons: see the scenery without buttons.', 'Draw distance: how far you can see (lower it if the game is slow).', 'Shader (shadows): also toggled with the L key.', 'Grid / tilt / edit buttons: choose whether they appear on screen.'] },
            { h: 'Opening this guide', items: ['Open this guide from "Help & Guide" at the top of Settings.', 'You can also open it from "Help & Guide" on the title screen.'] }
          ]
        }
      ]
    }
  };

  // 図の指定（文字は言語ごとに、ここで作る）
  function diagramFor(lang, spec) {
    if (spec === 'keys') return keysSvg(KEY_LAYOUT[lang] || KEY_LAYOUT.en);
    if (spec === 'flow:edit') return flowSvg(lang === 'ja' ? ['選ぶ', '動かす・回す・大きさ', '保存 / 取り消し'] : ['Select', 'Move / rotate / resize', 'Save / Cancel']);
    if (spec === 'flow:convert') return flowSvg(lang === 'ja' ? ['範囲を選ぶ', '部品に追加', '車両を作る', '車・バス・電車'] : ['Choose area', 'Add as part', 'Make vehicle', 'Car / bus / train']);
    return '';
  }

  // ============================================================
  // 状態・画面
  // ============================================================
  let lang = 'en';
  let catIndex = 0;
  let panel = null, tabsEl = null, bodyEl = null, langSel = null, titleEl = null;

  function detectLang() {
    try {
      const saved = localStorage.getItem(LANG_KEY);
      if (saved && LANG_TEXT[saved]) return saved;
    } catch (e) {}
    const nav = (navigator.language || 'en').toLowerCase();
    return nav.indexOf('ja') === 0 ? 'ja' : 'en';
  }
  function saveLang(v) { try { localStorage.setItem(LANG_KEY, v); } catch (e) {} }

  function esc(s) { return String(s); }

  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'helpPanel';
    panel.style.cssText = 'position:fixed;right:12px;top:12px;z-index:80;width:min(440px,94vw);height:min(72vh,640px);display:none;flex-direction:column;background:#fff;color:#1d2b3f;border-radius:14px;box-shadow:0 8px 28px rgba(0,0,0,.4);overflow:hidden;font-size:14px;line-height:1.6;box-sizing:border-box;touch-action:manipulation';
    panel.innerHTML = `
      <div id="hpHead" style="display:flex;align-items:center;gap:6px;padding:8px 10px;background:#3b6fb6;color:#fff;cursor:move;user-select:none">
        <b id="hpTitle" style="flex:1;font-size:15px"></b>
        <select id="hpLang" style="padding:2px 4px;border-radius:6px;color:#1d2b3f"></select>
        <button id="hpMin" style="${btnCss()}"></button>
        <button id="hpClose" style="${btnCss()}"></button>
      </div>
      <div id="hpTabs" style="display:flex;gap:4px;padding:6px;overflow-x:auto;border-bottom:1px solid #d6e0ee;background:#f4f7fc"></div>
      <div id="hpBody" style="flex:1;overflow:auto;padding:12px 14px"></div>`;
    document.body.appendChild(panel);
    tabsEl = document.getElementById('hpTabs');
    bodyEl = document.getElementById('hpBody');
    langSel = document.getElementById('hpLang');
    titleEl = document.getElementById('hpTitle');
    for (const k of Object.keys(LANG_TEXT)) {
      const o = document.createElement('option'); o.value = k; o.textContent = LANG_NAMES[k] || k;
      langSel.appendChild(o);
    }
    langSel.addEventListener('change', () => setLang(langSel.value));
    document.getElementById('hpClose').addEventListener('click', () => close());
    const mn = document.getElementById('hpMin');
    mn.addEventListener('click', () => {
      const min = bodyEl.style.display === 'none';
      bodyEl.style.display = min ? '' : 'none'; tabsEl.style.display = min ? '' : 'none';
      mn.textContent = min ? '_' : '□';
    });
    // ドラッグで移動（ヘッダーをつかむ）
    const head = document.getElementById('hpHead');
    let dx = 0, dy = 0, drag = false;
    head.addEventListener('pointerdown', e => {
      if (e.target.closest('button,select')) return;
      drag = true; const r = panel.getBoundingClientRect();
      dx = e.clientX - r.left; dy = e.clientY - r.top;
      panel.style.right = 'auto';
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', e => {
      if (!drag) return;
      panel.style.left = Math.max(0, e.clientX - dx) + 'px';
      panel.style.top = Math.max(0, e.clientY - dy) + 'px';
    });
    head.addEventListener('pointerup', () => { drag = false; });
    // 説明書の上での操作は、ゲームに伝えない（視点や置く操作が動かないように）
    for (const t of ['pointerdown', 'touchstart', 'mousedown', 'click', 'wheel']) {
      panel.addEventListener(t, e => e.stopPropagation(), { passive: true });
    }
    tabsEl.addEventListener('click', e => {
      const b = e.target.closest('[data-hi]');
      if (!b) return;
      catIndex = Number(b.dataset.hi);
      render();
    });
    applyLang();
  }
  function btnCss() { return 'padding:2px 9px;border-radius:6px;border:1px solid #fff8;background:#2d5a96;color:#fff;cursor:pointer;font-size:13px'; }

  function setLang(v) {
    if (!LANG_TEXT[v]) return;
    lang = v;
    saveLang(v);
    if (langSel) langSel.value = v;
    applyLang();
  }
  function applyLang() {
    if (!panel) return;
    const u = LANG_TEXT[lang].ui;
    titleEl.textContent = u.title;
    document.getElementById('hpClose').textContent = u.close;
    document.getElementById('hpMin').title = u.min;
    document.getElementById('hpHead').title = u.drag;
    langSel.value = lang;
    if (catIndex >= LANG_TEXT[lang].cats.length) catIndex = 0;
    render();
    // 入口のボタンの文字も合わせる
    for (const b of document.querySelectorAll('[data-help-entry]')) b.textContent = u.title;
  }
  function render() {
    const cats = LANG_TEXT[lang].cats;
    tabsEl.innerHTML = cats.map((c, i) => `<button data-hi="${i}" style="flex:none;padding:5px 10px;border-radius:999px;border:1px solid #9fb6d8;background:${i === catIndex ? '#3b6fb6' : '#fff'};color:${i === catIndex ? '#fff' : '#1d2b3f'};cursor:pointer;font-size:13px">${esc(c.tab)}</button>`).join('');
    const c = cats[catIndex];
    let h = `<h2 style="margin:0 0 6px;font-size:19px;color:#1d3b63">${esc(c.title)}</h2>`;
    h += `<p style="margin:0 0 10px;color:#334">${esc(c.intro)}</p>`;
    if (c.diagram) h += `<div style="margin:6px 0 12px;padding:8px;background:#f7faff;border-radius:10px">${diagramFor(lang, c.diagram)}</div>`;
    for (const s of c.sections) {
      h += `<h3 style="margin:12px 0 4px;font-size:15px;color:#2d5a96;border-left:4px solid #3b6fb6;padding-left:8px">${esc(s.h)}</h3>`;
      h += '<ul style="margin:0;padding-left:20px">' + s.items.map(t => `<li style="margin:3px 0">${esc(t)}</li>`).join('') + '</ul>';
    }
    bodyEl.innerHTML = h;
    bodyEl.scrollTop = 0;
  }

  function open(startCat) {
    if (!panel) return;
    if (typeof startCat === 'number') catIndex = startCat;
    panel.style.display = 'flex';
    bodyEl.style.display = ''; tabsEl.style.display = '';
    document.getElementById('hpMin').textContent = '_';
    render();
  }
  function close() { if (panel) panel.style.display = 'none'; }

  // ============================================================
  // 入口のボタン（タイトル画面・設定画面の一番上）
  // ============================================================
  function entryButton(extraStyle) {
    const b = document.createElement('button');
    b.setAttribute('data-help-entry', '1');
    b.style.cssText = 'display:block;width:100%;margin:6px 0;padding:8px 10px;border-radius:10px;border:1px solid #3b6fb6;background:#e8f1ff;color:#1d3b63;font-size:15px;cursor:pointer;touch-action:manipulation;' + (extraStyle || '');
    b.textContent = LANG_TEXT[lang].ui.title;
    b.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); open(); });
    b.addEventListener('pointerdown', e => e.stopPropagation());
    b.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
    return b;
  }
  function attachEntries() {
    const ov = document.getElementById('ovSettings');
    if (ov && !document.querySelector('[data-help-entry][data-where="title"]')) {
      const b = entryButton('margin:10px auto 0;max-width:260px;font-size:14px;padding:6px 10px');
      b.setAttribute('data-where', 'title');
      ov.parentNode.insertBefore(b, ov);
    }
    const head = document.querySelector('#settings .sbox h2');
    if (head && !document.querySelector('[data-help-entry][data-where="settings"]')) {
      const b = entryButton('');
      b.setAttribute('data-where', 'settings');
      head.parentNode.insertBefore(b, head.nextSibling);
    }
  }

  // 入口の準備：読み込みの順番に関係なく、画面ができたら付ける
  function start() {
    lang = detectLang();
    buildPanel();
    attachEntries();
    // 設定画面は、あとから作られるかもしれないので、少し待って確認する
    let tries = 0;
    const t = setInterval(() => {
      attachEntries();
      tries++;
      if (tries > 60) clearInterval(t);
    }, 500);
  }

  window.VoxelHelp = { open, close, setLang, languages: () => Object.keys(LANG_TEXT), _text: LANG_TEXT };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
