/* Sankyo Chat — bundled emoji list (rendered with the Windows emoji font; no images). */
(function (root) {
  'use strict';
  const SC = root.SC = root.SC || {};
  const RAW = [
    ['Smileys', '😀 grinning happy|😃 smiley happy|😄 smile happy|😁 grin|😆 laughing|😅 sweat smile phew|🤣 rofl lol|😂 joy tears lol|🙂 slight smile|😉 wink|😊 blush happy|😇 innocent halo|🥰 love hearts|😍 heart eyes love|🤩 star struck wow|😘 kiss|😋 yum delicious|😛 tongue|😜 wink tongue|🤪 zany crazy|🤗 hug|🤭 oops giggle|🤫 shush quiet|🤔 thinking hmm|🤐 zipper secret|😐 neutral meh|😑 expressionless|😶 speechless|😏 smirk|😒 unamused|🙄 eye roll|😬 grimace awkward|😌 relieved|😔 pensive sad|😪 sleepy|😴 sleeping tired|😷 mask sick|🤒 fever sick|🤕 hurt|🤧 sneeze cold|🥵 hot|🥶 cold freezing|😵 dizzy|🤯 mind blown|🥳 party celebrate|😎 cool sunglasses|🤓 nerd|🧐 monocle|😕 confused|😟 worried|🙁 frown sad|😮 wow open mouth|😲 astonished|😳 flushed|🥺 pleading please|😢 cry sad|😭 sob crying|😱 scream shock|😖 confounded|😣 persevere|😞 disappointed|😓 sweat|😩 weary|😫 tired|🥱 yawn bored|😤 huff|😠 angry|😡 rage pout|🤬 cursing|😈 devil|💀 skull dead|💩 poop|🤡 clown|👻 ghost|👽 alien|🤖 robot'],
    ['People', '👍 thumbs up yes like ok|👎 thumbs down no dislike|👌 ok perfect|✌️ victory peace|🤞 fingers crossed luck|🤟 love you|🤘 rock|👈 point left|👉 point right|👆 point up|👇 point down|☝️ index up|✋ hand stop|👋 wave hi hello bye|🖐️ hand|👏 clap applause|🙌 raise hands hooray|👐 open hands|🤲 palms|🙏 pray thanks please|🤝 handshake deal|💪 muscle strong|✍️ writing|👀 eyes look|🧠 brain smart|🤷 shrug dunno|🤦 facepalm|🙋 raise hand question|🙇 bow sorry|💁 info|🙆 ok gesture|🙅 no gesture|👨‍💻 developer|👩‍💻 developer|🧑‍🤝‍🧑 people together'],
    ['Symbols', '❤️ heart love red|🧡 orange heart|💛 yellow heart|💚 green heart|💙 blue heart|💜 purple heart|🖤 black heart|🤍 white heart|💔 broken heart|💕 hearts|💯 hundred perfect|💥 boom|💫 dizzy star|💤 zzz sleep|💬 speech chat|🔥 fire lit hot|✨ sparkles|⭐ star|🌟 glowing star|⚡ zap lightning|✅ check done yes|☑️ checkbox|✔️ check|❌ cross no wrong|❗ exclamation important|❓ question|⚠️ warning caution|🚫 no entry forbidden|🆗 ok button|🆕 new|🔴 red circle|🟠 orange circle|🟡 yellow circle|🟢 green circle|🔵 blue circle|➕ plus|➖ minus|➡️ right arrow|⬅️ left arrow|⬆️ up arrow|⬇️ down arrow|🔁 repeat|♻️ recycle'],
    ['Celebrate', '🎉 tada party congrats|🎊 confetti|🎂 birthday cake|🎁 gift present|🎈 balloon|🏆 trophy win|🥇 gold medal first|🥈 silver medal|🥉 bronze medal|🎯 target bullseye|🎮 game|🎲 dice|⚽ soccer football|🏀 basketball|🏐 volleyball|🎵 music note|🎶 music notes|🎤 microphone sing|🎬 movie|📸 camera photo'],
    ['Food', '☕ coffee|🍵 tea|🧋 milk tea boba|🥤 drink soda|🍺 beer|🍻 cheers|🍷 wine|🍕 pizza|🍔 burger|🍟 fries|🌭 hotdog|🍗 chicken|🍜 noodles ramen|🍝 pasta|🍣 sushi|🍱 bento|🍚 rice|🍛 curry|🍞 bread|🥐 croissant|🥪 sandwich|🥗 salad|🍩 donut|🍪 cookie|🍰 cake|🧁 cupcake|🍫 chocolate|🍦 ice cream|🍎 apple|🍌 banana|🍉 watermelon|🥭 mango|🍍 pineapple|🍓 strawberry'],
    ['Work', '💻 laptop computer|🖥️ desktop monitor|🖨️ printer|⌨️ keyboard|🖱️ mouse|📱 phone mobile|☎️ telephone|📞 phone call|📧 email|📨 incoming mail|📅 calendar date|🗓️ calendar|📌 pin|📍 location|📎 paperclip attachment|✂️ scissors|📝 memo note|📄 document page|📁 folder|📂 open folder|🗂️ dividers|📊 bar chart|📈 chart up growth|📉 chart down|📋 clipboard|🔒 lock secure|🔓 unlocked|🔑 key|🔧 wrench fix|🔨 hammer|🛠️ tools|⚙️ gear settings|💡 idea bulb|🔋 battery|🔌 plug|📦 package box delivery|🚚 truck delivery|🚗 car|🚌 bus|✈️ plane travel|🏠 home house|🏢 office building|🏥 hospital|⏰ alarm clock|⏳ hourglass waiting|⌛ hourglass done|💰 money bag|💵 cash dollar|🧾 receipt|📢 announcement|🔔 bell notification|🔕 mute'],
    ['Nature', '☀️ sun sunny|🌤️ sun cloud|⛅ cloudy|🌧️ rain|⛈️ storm|🌈 rainbow|❄️ snow cold|🌊 wave ocean|🌙 moon night|🌍 earth world|🌸 blossom flower|🌻 sunflower|🌹 rose|🍀 clover luck|🌱 seedling grow|🌴 palm tree|🌵 cactus|🍂 leaves autumn|🐶 dog|🐱 cat|🐭 mouse|🐰 rabbit|🦊 fox|🐻 bear|🐼 panda|🐨 koala|🐯 tiger|🦁 lion|🐸 frog|🐵 monkey|🐧 penguin|🦉 owl|🦄 unicorn|🐝 bee|🦋 butterfly|🐢 turtle|🐙 octopus|🐬 dolphin|🐳 whale'],
  ];
  /** @type {{category:string, items:{e:string, k:string}[]}[]} */
  const list = RAW.map(([category, s]) => ({
    category,
    items: s.split('|').map(x => { const i = x.indexOf(' '); return { e: x.slice(0, i), k: x.slice(i + 1) }; }),
  }));
  SC.emoji = {
    list,
    quick: ['👍', '❤️', '😂', '🎉', '🙏', '👀'],
    search(q) {
      q = String(q || '').toLowerCase().trim();
      const all = list.flatMap(c => c.items);
      return q ? all.filter(it => it.k.includes(q)) : all;
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
