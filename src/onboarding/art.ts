// Onboarding illustrations. Colours come from --art-* tokens, which map to the app theme (light and dark), drawn as inline SVG so taps can animate parts of them.
// Parts that react carry a class: .fx (shows when on), .led, .blades, .screen, .bulb, .win (lit windows).
const B = 'var(--art-line)'      // outline brown
const S = `stroke="${B}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"`
const svg = (w: number, h: number, body: string) =>
  `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`
const pad = '<rect x="4" y="4" width="112" height="112" rx="28" fill="var(--art-bg)"/>'

export const APPLIANCES = {
  fridge: svg(120, 120, `${pad}
    <g class="fx cold"><path d="M18 40q4-5 8 0t8 0M16 58q4-5 8 0t8 0M18 76q4-5 8 0t8 0" fill="none" stroke="var(--art-cool)" stroke-width="3" stroke-linecap="round"/></g>
    <rect x="40" y="14" width="46" height="92" rx="9" fill="var(--art-paper)" ${S}/><path d="M40 46h46" ${S}/>
    <rect x="76" y="24" width="4" height="14" rx="2" fill="${B}"/><rect x="76" y="56" width="4" height="24" rx="2" fill="${B}"/>
    <circle class="led" cx="50" cy="24" r="3.5" fill="var(--art-mid)"/>`),
  kettle: svg(120, 120, `${pad}
    <g class="fx steam" fill="none" stroke="var(--art-mid)" stroke-width="3" stroke-linecap="round"><path d="M22 40q-5-6 0-12t0-12"/><path d="M32 38q-5-6 0-12t0-12"/></g>
    <path d="M40 54 22 46l4-5 16 7" fill="var(--art-fill-2)" ${S}/>
    <path d="M84 58q18 2 14 22-3 10-10 10" fill="none" ${S} stroke-width="5"/>
    <path d="M40 50h44l6 46q-30 8-56 0z" fill="var(--art-fill-2)" ${S}/>
    <path d="M46 50q16-16 32 0" fill="var(--art-fill)" ${S}/><circle cx="62" cy="38" r="4" fill="${B}"/>
    <rect x="30" y="96" width="64" height="9" rx="4.5" fill="${B}"/><circle class="led" cx="46" cy="88" r="3.5" fill="var(--art-mid)"/>`),
  fan: svg(120, 120, `${pad}
    <rect x="57" y="62" width="6" height="36" rx="3" fill="${B}"/><ellipse cx="60" cy="100" rx="22" ry="6" fill="${B}"/>
    <circle cx="60" cy="44" r="31" fill="var(--art-paper)" stroke="var(--art-mid)" stroke-width="3"/>
    <g class="blades"><ellipse cx="60" cy="27" rx="8" ry="16" fill="var(--art-accent-soft)" ${S}/><ellipse cx="60" cy="27" rx="8" ry="16" fill="var(--art-accent-soft)" ${S} transform="rotate(120 60 44)"/><ellipse cx="60" cy="27" rx="8" ry="16" fill="var(--art-accent-soft)" ${S} transform="rotate(240 60 44)"/></g>
    <circle cx="60" cy="44" r="7" fill="var(--art-strong)" ${S}/>`),
  tv: svg(120, 120, `${pad}
    <path d="M42 82 34 98M78 82l8 16" ${S}/>
    <rect x="16" y="24" width="88" height="58" rx="8" fill="var(--art-dark)" ${S}/>
    <rect class="screen" x="23" y="31" width="74" height="44" rx="4" fill="var(--art-dark-2)"/>
    <g class="fx"><circle cx="78" cy="44" r="7" fill="var(--art-glow)"/><path d="M23 75v-12q16-14 30-4t24-6 20 6v16z" fill="var(--art-accent)"/></g>`),
  ac: svg(120, 120, `${pad}
    <rect x="14" y="28" width="92" height="36" rx="12" fill="var(--art-paper)" ${S}/><path d="M26 52h68M26 58h68" stroke="var(--art-mid)" stroke-width="3" stroke-linecap="round"/>
    <circle class="led" cx="94" cy="39" r="3.5" fill="var(--art-mid)"/>
    <g class="fx air" fill="none" stroke="var(--art-cool)" stroke-width="4" stroke-linecap="round"><path d="M34 74q6 6 0 12t0 12"/><path d="M60 74q6 6 0 12t0 12"/><path d="M86 74q6 6 0 12t0 12"/></g>`),
  iron: svg(120, 120, `${pad}
    <g class="fx steam" fill="var(--art-mid)"><circle cx="36" cy="102" r="3"/><circle cx="52" cy="104" r="3"/><circle cx="68" cy="102" r="3"/><circle cx="84" cy="104" r="3"/></g>
    <path d="M54 56q2-22 24-22h14q4 0 4 6v16" fill="none" ${S} stroke-width="5"/>
    <path d="M22 88q6-32 48-32h26q4 0 4 6v26z" fill="var(--art-fill-2)" ${S}/><rect x="22" y="88" width="78" height="7" rx="3.5" fill="var(--art-mid-2)" ${S}/>
    <circle class="led" cx="84" cy="70" r="3.5" fill="var(--art-mid)"/>`),
  pump: svg(120, 120, `${pad}
    <path class="fx drop" d="M91 14q7 9 0 14-7-5 0-14z" fill="var(--art-cool)"/>
    <rect x="86" y="30" width="10" height="34" fill="var(--art-mid)" ${S}/><rect x="62" y="58" width="34" height="12" fill="var(--art-mid)" ${S}/>
    <rect x="20" y="46" width="46" height="38" rx="9" fill="var(--art-accent-soft)" ${S}/><path d="M32 54v22M42 54v22M52 54v22" stroke="var(--art-accent)" stroke-width="3" stroke-linecap="round"/>
    <rect x="16" y="84" width="54" height="9" rx="4.5" fill="${B}"/><circle class="led" cx="58" cy="54" r="3" fill="var(--art-mid)"/>`),
  lights: svg(120, 120, `${pad}
    <g class="fx rays" stroke="var(--art-warn)" stroke-width="4" stroke-linecap="round"><path d="M60 6v8M14 48h8M98 48h8M28 18l6 6M92 18l-6 6"/></g>
    <circle class="fx halo" cx="60" cy="48" r="34" fill="var(--art-glow)" opacity=".35"/>
    <path class="bulb" d="M60 22a26 26 0 0 0-14 48v8h28v-8a26 26 0 0 0-14-48z" fill="var(--art-paper)" ${S}/>
    <path d="M52 52q4-8 8 0t8 0" fill="none" stroke="var(--art-strong)" stroke-width="3" stroke-linecap="round"/>
    <rect x="47" y="78" width="26" height="16" rx="4" fill="var(--art-mid-2)" ${S}/><path d="M47 86h26" ${S}/>`),
} as const

const ground = '<rect x="6" y="106" width="148" height="6" rx="3" fill="var(--art-mid)"/>'
const tree = (x: number) => `<rect x="${x - 2}" y="80" width="4" height="26" fill="${B}"/><circle cx="${x}" cy="74" r="13" fill="var(--art-accent)" ${S}/>`
const win = (x: number, y: number, w = 12, h = 12) => `<rect class="win" x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="var(--art-paper)" stroke="${B}" stroke-width="2.5"/>`

export const HOMES = {
  apartment: svg(160, 120, `${ground}${tree(132)}
    <rect x="46" y="16" width="64" height="90" rx="4" fill="var(--art-fill)" ${S}/><rect x="42" y="12" width="72" height="8" rx="3" fill="var(--art-strong)" ${S}/>
    ${[28, 46, 64].map(y => [54, 72, 90].map(x => win(x, y)).join('')).join('')}
    <rect x="70" y="84" width="16" height="22" rx="2" fill="var(--art-strong)" ${S}/>`),
  compound: svg(160, 120, `${ground}${tree(24)}
    <path d="M44 52 66 36l22 16" fill="var(--art-strong)" ${S}/><rect x="48" y="50" width="36" height="34" fill="var(--art-fill)" ${S}/>${win(54, 58)}
    <path d="M88 48l24-18 24 18" fill="var(--art-strong)" ${S}/><rect x="92" y="46" width="40" height="38" fill="var(--art-fill)" ${S}/>${win(98, 56)}${win(114, 56)}
    <rect x="36" y="76" width="108" height="30" fill="var(--art-fill-2)" ${S}/><rect x="80" y="84" width="20" height="22" rx="2" fill="var(--art-paper)" ${S}/><path d="M90 84v22" ${S}/>`),
  detached: svg(160, 120, `${ground}${tree(136)}
    <g class="fx smoke" fill="var(--art-mid)"><circle cx="102" cy="14" r="5"/><circle cx="108" cy="6" r="4"/></g>
    <rect x="96" y="24" width="12" height="20" fill="var(--art-strong)" ${S}/>
    <rect x="38" y="54" width="84" height="52" fill="var(--art-fill)" ${S}/><path d="M30 58 80 20l50 38z" fill="var(--art-strong)" ${S}/>
    ${win(48, 66, 18, 16)}${win(96, 66, 18, 16)}<rect x="72" y="78" width="18" height="28" rx="2" fill="var(--art-fill-2)" ${S}/>`),
  shop: svg(160, 120, `${ground}
    <rect x="28" y="22" width="104" height="84" fill="var(--art-fill)" ${S}/>${win(40, 30)}${win(74, 30)}${win(108, 30)}
    <path d="M22 56h116l-6 14H28z" fill="var(--art-paper)" ${S}/>${[0, 2, 4, 6].map(i => `<path d="M${36 + i * 14} 56h14l-2 14h-14z" fill="var(--art-strong)"/>`).join('')}
    ${win(38, 76, 52, 30)}<rect x="100" y="76" width="22" height="30" rx="2" fill="var(--art-fill-2)" ${S}/>`),
} as const

const floor = '<rect x="8" y="8" width="104" height="104" rx="16" fill="var(--art-paper)" stroke="var(--art-fill-2)" stroke-width="3"/>'
export const ROOMS = {
  bedroom: svg(120, 120, `${floor}<rect x="28" y="20" width="62" height="78" rx="9" fill="var(--art-fill)" ${S}/>
    <rect x="34" y="26" width="22" height="14" rx="5" fill="var(--art-paper)" ${S}/><rect x="62" y="26" width="22" height="14" rx="5" fill="var(--art-paper)" ${S}/>
    <rect x="28" y="50" width="62" height="48" rx="9" fill="var(--art-strong)" ${S}/><rect x="94" y="20" width="12" height="14" rx="3" fill="var(--art-fill-2)" ${S}/>`),
  kitchen: svg(120, 120, `${floor}<path d="M16 16h88v26H42v62H16z" fill="var(--art-fill-2)" ${S}/>
    <circle cx="58" cy="29" r="6" fill="var(--art-dark)"/><circle cx="76" cy="29" r="6" fill="var(--art-dark)"/>
    <rect x="21" y="56" width="16" height="22" rx="4" fill="var(--art-cool)" ${S}/><circle cx="78" cy="78" r="16" fill="var(--art-fill)" ${S}/>`),
  living: svg(120, 120, `${floor}<ellipse cx="62" cy="70" rx="34" ry="22" fill="var(--art-fill)"/>
    <path d="M18 22h84v20H40v56H18z" fill="var(--art-accent-soft)" ${S}/><rect x="56" y="60" width="28" height="18" rx="4" fill="var(--art-fill-2)" ${S}/>
    <circle cx="96" cy="96" r="9" fill="var(--art-accent)" ${S}/>`),
  bathroom: svg(120, 120, `${floor}<rect x="16" y="16" width="44" height="80" rx="18" fill="var(--art-cool-soft)" ${S}/>
    <ellipse cx="88" cy="34" rx="12" ry="15" fill="var(--art-paper)" ${S}/><rect x="78" y="16" width="20" height="8" rx="3" fill="var(--art-paper)" ${S}/>
    <rect x="74" y="74" width="28" height="22" rx="8" fill="var(--art-paper)" ${S}/><circle cx="88" cy="85" r="4" fill="var(--art-cool)"/>`),
  office: svg(120, 120, `${floor}<rect x="18" y="20" width="84" height="32" rx="5" fill="var(--art-fill-2)" ${S}/>
    <rect x="44" y="26" width="32" height="20" rx="3" fill="var(--art-dark)" ${S}/><rect class="screen" x="48" y="29" width="24" height="13" rx="2" fill="var(--art-cool-soft)"/>
    <circle cx="60" cy="76" r="16" fill="var(--art-accent-soft)" ${S}/><circle cx="92" cy="92" r="9" fill="var(--art-accent)" ${S}/>`),
  store: svg(120, 120, `${floor}<rect x="16" y="18" width="88" height="16" rx="3" fill="var(--art-fill-2)" ${S}/><rect x="16" y="86" width="88" height="16" rx="3" fill="var(--art-fill-2)" ${S}/>
    <rect x="24" y="44" width="22" height="22" rx="3" fill="var(--art-fill)" ${S}/><rect x="52" y="50" width="18" height="18" rx="3" fill="var(--art-strong)" ${S}/><rect x="76" y="44" width="22" height="22" rx="3" fill="var(--art-fill)" ${S}/>`),
  porch: svg(120, 120, `${floor}<rect x="16" y="78" width="88" height="12" rx="3" fill="var(--art-fill-2)" ${S}/><rect x="24" y="90" width="72" height="12" rx="3" fill="var(--art-fill)" ${S}/>
    <rect x="22" y="40" width="16" height="22" rx="4" fill="var(--art-strong)" ${S}/><circle cx="30" cy="34" r="10" fill="var(--art-accent)" ${S}/>
    <rect x="66" y="30" width="30" height="34" rx="8" fill="var(--art-accent-soft)" ${S}/>`),
} as const

// Short product lessons: what you see, and what to expect. Each scene plays when tapped.
const mini = (key: keyof typeof APPLIANCES, x: number, y: number, s = 0.5) =>
  `<g class="mini" transform="translate(${x} ${y}) scale(${s})">${APPLIANCES[key].replace(/^<svg[^>]*>|<\/svg>$/g, '')}</g>`
export const LESSONS = {
  live: svg(320, 200, `<rect x="40" y="70" width="240" height="116" rx="10" fill="var(--art-paper)" ${S}/><path d="M28 76 160 14l132 62z" fill="var(--art-strong)" ${S}/>
    <path d="M120 70v116M200 70v116" ${S}/>
    <g class="room r1"><rect x="44" y="74" width="72" height="108" rx="6" fill="var(--art-glow)" opacity=".0"/></g>
    <g class="room r2"><rect x="124" y="74" width="72" height="108" rx="6" fill="var(--art-glow)" opacity=".0"/></g>
    <g class="room r3"><rect x="204" y="74" width="72" height="108" rx="6" fill="var(--art-glow)" opacity=".0"/></g>
    ${mini('kettle', 50, 104)}${mini('tv', 130, 104)}${mini('fridge', 210, 104)}
    <g class="badge"><rect x="210" y="22" width="92" height="34" rx="17" fill="var(--art-accent)"/><path d="m236 30-8 11h6l-1 8 9-11h-6z" fill="#fff"/><rect x="252" y="35" width="38" height="8" rx="4" fill="#fff"/></g>`),
  ask: svg(320, 200, `<g class="b1"><rect x="96" y="24" width="200" height="44" rx="22" fill="var(--art-accent)"/><text x="196" y="51" text-anchor="middle" font-size="14" fill="var(--art-on-accent)">How long was the kettle on?</text></g>
    <g class="dots"><rect x="30" y="86" width="84" height="40" rx="20" fill="var(--art-bg)" ${S}/><circle cx="56" cy="106" r="5" fill="${B}"/><circle cx="72" cy="106" r="5" fill="${B}"/><circle cx="88" cy="106" r="5" fill="${B}"/></g>
    <g class="b2"><rect x="30" y="86" width="230" height="84" rx="22" fill="var(--art-bg)" ${S}/>${mini('kettle', 40, 98, 0.5)}<text x="110" y="122" font-size="14" fill="${B}">About 12 minutes today</text><text x="110" y="144" font-size="12" fill="var(--art-mid-2)">0.4 kWh · GH₵ 0.70</text></g>`),
  heads_up: svg(320, 200, `${mini('fridge', 60, 40, 1)}
    <g class="pulse"><circle cx="168" cy="52" r="22" fill="var(--art-glow)" opacity=".4"/><circle cx="168" cy="52" r="14" fill="var(--art-warn)"/><path d="M168 44v9M168 58v1" stroke="#fff" stroke-width="4" stroke-linecap="round"/></g>
    <g class="bell" transform-origin="250 60"><path d="M228 96v-26a22 22 0 0 1 44 0v26l8 8h-60z" fill="var(--art-fill-2)" ${S}/><circle cx="250" cy="112" r="7" fill="${B}"/><rect x="246" y="34" width="8" height="8" rx="3" fill="${B}"/></g>`),
  teach: svg(320, 200, `${mini('kettle', 100, 40, 1)}
    <circle cx="160" cy="100" r="86" fill="none" stroke="var(--art-bg)" stroke-width="10"/>
    <circle class="ring" cx="160" cy="100" r="86" fill="none" stroke="var(--art-accent)" stroke-width="10" stroke-linecap="round" stroke-dasharray="540" stroke-dashoffset="540" transform="rotate(-90 160 100)"/>
    <g class="check"><circle cx="232" cy="40" r="20" fill="var(--art-accent)"/><path d="m222 40 7 7 13-14" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></g>`),
} as const

export const HERO = {
  welcome: svg(320, 220, `<circle class="sun" cx="250" cy="52" r="26" fill="var(--art-glow)"/>
    <rect x="20" y="196" width="280" height="8" rx="4" fill="var(--art-mid)"/>${''}
    <rect x="80" y="104" width="160" height="92" fill="var(--art-fill)" ${S}/><path d="M64 110 160 40l96 70z" fill="var(--art-strong)" ${S}/>
    ${win(100, 124, 30, 26)}${win(190, 124, 30, 26)}<rect x="146" y="146" width="28" height="50" rx="3" fill="var(--art-fill-2)" ${S}/>
    <path class="heart" d="M160 96c-10-12-28-2-18 12l18 16 18-16c10-14-8-24-18-12z" fill="#fff" ${S} stroke-width="2.5"/>`),
  done: svg(320, 220, `<g class="confetti">${[[40, 30, 'var(--art-strong)'], [80, 60, 'var(--art-accent)'], [250, 34, 'var(--art-warn)'], [280, 80, 'var(--art-strong)'], [60, 110, 'var(--art-cool)'], [270, 130, 'var(--art-accent)'], [120, 24, 'var(--art-warn)'], [210, 14, 'var(--art-cool)']].map(([x, y, c], i) => `<rect x="${x}" y="${y}" width="10" height="6" rx="2" fill="${c}" transform="rotate(${i * 37} ${x} ${y})"/>`).join('')}</g>
    <rect x="20" y="196" width="280" height="8" rx="4" fill="var(--art-mid)"/>
    <rect x="90" y="110" width="140" height="86" fill="var(--art-fill)" ${S}/><path d="M76 116 160 52l84 64z" fill="var(--art-strong)" ${S}/>
    ${win(108, 130, 26, 22)}${win(186, 130, 26, 22)}<rect x="148" y="150" width="24" height="46" rx="3" fill="var(--art-fill-2)" ${S}/>
    <g class="badge"><circle cx="232" cy="74" r="24" fill="var(--art-accent)" ${S}/><path d="m220 74 8 8 16-17" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></g>`),
} as const

export const WATTS: Record<keyof typeof APPLIANCES, number> = { fridge: 150, kettle: 1800, fan: 60, tv: 95, ac: 1350, iron: 1000, pump: 750, lights: 24 }
