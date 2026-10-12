export type Theme = 'dark' | 'light'
export function loadTheme(): Theme {
 try{return localStorage.getItem('current-theme')==='light'?'light':'dark'}catch{return 'dark'}
}
export function applyTheme(theme:Theme){
 document.documentElement.dataset.theme=theme
 document.documentElement.style.colorScheme=theme
 document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='dark'?'#161718':'#f5f5f3')
 try{localStorage.setItem('current-theme',theme)}catch{/* The theme still works when browser storage is unavailable. */}
}
