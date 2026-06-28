# Spec de animação — Filme da Copa (Histórico, admin-only)

Gerado por workflow multi-agente (5 lentes + síntese). Estado: **spec pronto, NADA aplicado ainda em `bolao2026.html`**.
Harness de preview fiel: `lab-filme.html` (dados fictícios + funções reais; renderiza sem login, já que claudinho não é admin).

## Alvos no código real (bolao2026.html)
- CSS filme: linhas ~3835-3859. Reduced-motion: adicionar bloco consolidado (ver globalNotes).
- JS filme: `renderFilme` ~8129, `filmeApplyFrame` ~8170, `filmeChartSvg` ~8098, `filmeTogglePlay`/`filmeStop` ~8234-8257, `FILME_SPEED_MS` ~8056.

## Princípios
1. Energia ambiente DESACOPLADA do dado: fluxo da barra roda em `background-position` (só compositor), independe de pontos mudarem → corrida estagnada ainda parece viva (pedido central do Léo).
2. "Juice" só onde há significado: fluxo gated ao líder + barras ao vivo; overtake dá pop; gol dá ripple; placar faz roll-up.
3. Uma linguagem de timing: vars CSS (`--filme-ease`, `--filme-flow-dur`, `--filme-dur-ui`) + espelho JS (`FILME_EASE`); duração do fluxo reescrita por frame conforme a velocidade (1x/2x/4x retemporiza na hora).
4. Compositor-first; MANTER `width` na barra (NÃO trocar por scaleX — distorce cantos arredondados e o overlay de brilho). Custo controlado por gating + will-change só durante playback.
5. A11y JS-aware: reduced-motion no JS (`moveMs/sweepMs=0`) + 1 bloco @media consolidado.
6. Reusar vocabulário existente (marching ants, live pulse).

## DECISÃO-CHAVE (centerpiece)
Cor do participante é INLINE em `.filme-bar` (linha 8153) → o fluxo TEM que ser `::after` (regra de stylesheet perde pra inline). `background-size` em PX (52px), não %, pra textura NÃO esticar/comprimir quando a largura anima. `background-position-x: 0 → -52px` (1 tile) = loop perfeito; movimento da posição p/ esquerda lê como fluxo p/ direita. `overflow:hidden` recorta nos cantos.

---

## Mudanças (ordem de aplicação)

### 1 [core] timing-tokens
- `renderFilme` 8144: `<div class="card">` → `<div class="card" id="filmeCard">`.
- Perto de FILME_SPEED_MS (8056): `const FILME_EASE='cubic-bezier(.3,.6,.3,1)';`
- CSS:
```css
#filmeCard{
  --filme-ease:cubic-bezier(.3,.6,.3,1);
  --filme-ease-emph:cubic-bezier(.34,1.56,.64,1);
  --filme-dur-seek:420ms;
  --filme-dur-ui:180ms;
  --filme-flow-dur:1.15s; /* reescrito por frame via JS conforme velocidade */
}
```

### 2 [core] reduced-motion master switch (a11y crítico — filme hoje tem ZERO)
- Perto de FILME_SPEED_MS (8056):
```js
const _filmeRM = window.matchMedia ? window.matchMedia('(prefers-reduced-motion:reduce)') : {matches:false,addEventListener(){}};
function filmeReduced(){ return !!_filmeRM.matches; }
_filmeRM.addEventListener && _filmeRM.addEventListener('change', ()=>{ if(filmeReduced()) filmeStop(); });
```
- `filmeApplyFrame` REPLACE 8179-8180:
```js
const rm=filmeReduced();
const moveMs=(!animate||rm)?0:filmePlaying?Math.round(stepMs*0.92):420;
const sweepMs=(!animate||rm)?0:filmePlaying?stepMs:420;
```

### 3 [core] keep-width-not-scalex
Manter o bloco da barra (8186-8190), só trocando a easing pelo token:
```js
if(bar){
  bar.style.transition=moveMs?`width ${moveMs}ms ${FILME_EASE}`:'none';
  bar.style.width=`${Math.max(0.5,Math.max(0,e.pts)/data.maxVal*100)}%`;
}
```
NÃO criar inner fill nem scaleX. `.filme-bar` ganha `position:relative;overflow:hidden` (vem da mudança 4).

### 4 [core] CENTERPIECE — fluxo de energia esquerda→direita via ::after
```css
@keyframes filmeBarFlow{from{background-position-x:0}to{background-position-x:-52px}}
```
```css
.filme-row .filme-bar{position:relative;overflow:hidden}
.filme-row .filme-bar::after{
  content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;
  background-image:repeating-linear-gradient(115deg,
    rgba(255,255,255,0) 0px,rgba(255,255,255,0) 14px,
    rgba(255,255,255,.16) 22px,rgba(255,255,255,.22) 26px,
    rgba(255,255,255,.16) 30px,rgba(255,255,255,0) 38px);
  background-size:52px 100%;background-repeat:repeat;
  opacity:0;transition:opacity .35s ease;will-change:background-position;
}
.filme-row.is-flowing .filme-bar::after{opacity:1;animation:filmeBarFlow var(--filme-flow-dur,1.15s) linear infinite}
```

### 5 [core] gating do fluxo (líder sempre; barras ao vivo mais fortes; retiming por velocidade)
```css
@keyframes filmeBarLivePulse{0%,100%{filter:brightness(1)}50%{filter:brightness(1.12)}}
.filme-row.is-live .filme-bar::after{
  background-image:repeating-linear-gradient(115deg,
    rgba(255,255,255,0) 0px,rgba(255,255,255,0) 12px,
    rgba(255,255,255,.24) 20px,rgba(255,255,255,.34) 26px,
    rgba(255,255,255,.24) 32px,rgba(255,255,255,0) 40px);
  opacity:1;
  animation:filmeBarFlow calc(var(--filme-flow-dur,1.15s) * .55) linear infinite,
            filmeBarLivePulse 1.6s ease-in-out infinite;
}
.filme-row.is-live .filme-bar{box-shadow:0 0 0 1.5px rgba(216,58,52,.55),0 0 0 4px rgba(216,58,52,.12)}
```
JS em `filmeApplyFrame`:
- após moveMs/sweepMs: `const card=document.getElementById('filmeCard'); if(card) card.style.setProperty('--filme-flow-dur',(filmeSpeed>=4?'.8s':filmeSpeed>=2?'1s':'1.15s'));`
- dentro do forEach, após o bloco da barra:
```js
if(row){
  const flowing=filmePlaying;
  row.classList.toggle('is-flowing',flowing||(e.pos===0&&filmePlaying));
  const liveRow=filmePlaying&&frame.state==='live'&&e.delta!==0;
  row.classList.toggle('is-live',liveRow);
}
```

### 6 [core] will-change/contain só durante playback
```css
.filme-stage{contain:layout paint}
.filme-chart{contain:layout paint}
.filme-stage.is-playing .filme-row{will-change:transform}
.filme-stage.is-playing .filme-row.is-flowing .filme-bar::after{will-change:background-position}
```
- `filmeTogglePlay` após `filmePlaying=true;`: add `.is-playing` em #filmeStage e `.playing` em `#filmeCard .filme-chart`.
- `filmeStop`: remover ambos. (NÃO usar `contain:size` — altura do stage é inline.)

### 7 [highend] pts roll-up (odômetro)
```js
function filmeRollNumber(el,to,dur){
  const from=parseInt(el.dataset.val||'0',10)||0; to=Math.round(to);
  el.dataset.val=String(to);
  if(!dur||from===to||filmeReduced()){el.textContent=to;return;}
  const t0=performance.now(); if(el._raf)cancelAnimationFrame(el._raf);
  const ease=p=>1-Math.pow(1-p,3);
  const step=now=>{const p=Math.min(1,(now-t0)/dur);el.textContent=Math.round(from+(to-from)*ease(p));if(p<1)el._raf=requestAnimationFrame(step);};
  el._raf=requestAnimationFrame(step);
}
```
Linha 8194 `if(ptsEl) ptsEl.textContent=e.pts;` → `if(ptsEl) filmeRollNumber(ptsEl,e.pts,animate?moveMs:0);`

### 8 [highend] overtake pop + entrada de delta/trend
ATENÇÃO: transform da row vira `translateY(var(--row-y))` pra keyframe não jogar a row pro topo.
```css
@keyframes filmeOvertake{0%{transform:translateY(var(--row-y)) scale(1);box-shadow:none}30%{transform:translateY(var(--row-y)) scale(1.05);box-shadow:0 6px 22px var(--row-glow,rgba(0,39,118,.35))}100%{transform:translateY(var(--row-y)) scale(1);box-shadow:none}}
@keyframes filmeDeltaIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
@keyframes filmeTrendPop{0%{transform:scale(.4);opacity:0}60%{transform:scale(1.25)}100%{transform:scale(1);opacity:1}}
.filme-row.filme-overtake{z-index:3;animation:filmeOvertake .5s var(--filme-ease-emph,cubic-bezier(.34,1.56,.64,1))}
.filme-delta.show{animation:filmeDeltaIn .32s ease-out}
.filme-trend.show{display:inline-block;animation:filmeTrendPop .36s var(--filme-ease-emph,cubic-bezier(.34,1.56,.64,1))}
```
JS — REPLACE linhas 8184-8185 (transform da row) por:
```js
row.style.setProperty('--row-y',(e.pos*rowH)+'px');
row.style.setProperty('--row-glow',e.color);
row.style.transition=moveMs?`transform ${moveMs}ms ${FILME_EASE}`:'none';
row.style.transform='translateY(var(--row-y))';
if(animate&&!filmeReduced()&&e.moved<0){
  row.classList.remove('filme-overtake');void row.offsetWidth;row.classList.add('filme-overtake');
  row.addEventListener('animationend',()=>row.classList.remove('filme-overtake'),{once:true});
}
```
após bloco deltaEl (8198): `if(animate&&!filmeReduced()&&e.delta){deltaEl.classList.remove('show');void deltaEl.offsetWidth;deltaEl.classList.add('show');}`
após bloco trendEl (8203): `if(animate&&!filmeReduced()&&e.moved){trendEl.classList.remove('show');void trendEl.offsetWidth;trendEl.classList.add('show');}`

### 9 [highend] gol ripple sincronizado
```css
@keyframes filmeGoalPulse{0%{box-shadow:0 0 0 0 var(--row-glow,rgba(0,39,118,.5))}70%{box-shadow:0 0 0 10px rgba(0,0,0,0)}100%{box-shadow:0 0 0 0 rgba(0,0,0,0)}}
.filme-row .filme-bar.goal{animation:filmeGoalPulse .55s ease-out}
```
dentro de `if(bar){...}` após width:
```js
if(animate&&!filmeReduced()&&frame.event&&e.delta>0){
  bar.style.setProperty('--row-glow',e.color);
  bar.classList.remove('goal');void bar.offsetWidth;bar.classList.add('goal');
  bar.addEventListener('animationend',()=>bar.classList.remove('goal'),{once:true});
}
```

### 10 [highend] chart — marching ants no segmento ao vivo + playhead com glow/pulse
```css
@keyframes filmeAnts{to{stroke-dashoffset:-26}}
@keyframes filmeCursorPulse{0%,100%{opacity:.45}50%{opacity:.75}}
.filme-chart svg path.filme-line-live{stroke-dasharray:7 6}
.filme-chart.playing svg path.filme-line-live{animation:filmeAnts 1s linear infinite}
#filmeCursorRect{filter:drop-shadow(0 0 3px rgba(0,39,118,.5))}
.filme-chart.playing #filmeCursorRect{animation:filmeCursorPulse 1.1s ease-in-out infinite}
```
`filmeChartSvg` linha 8109 (path dashed): adicionar `class="filme-line-live"` e `stroke-dasharray="7 6"`.

### 11 [optional] polish dos controles
```css
.filme-speed button{transition:background var(--filme-dur-ui,180ms) var(--filme-ease),color var(--filme-dur-ui,180ms) var(--filme-ease),box-shadow var(--filme-dur-ui,180ms) var(--filme-ease)}
.filme-speed button.active{outline:none;background:var(--blue);color:#fff;box-shadow:0 2px 8px rgba(0,39,118,.25)}
#filmePlayBtn{transition:transform var(--filme-dur-ui,180ms) var(--filme-ease)}
#filmePlayBtn:active{transform:scale(.97)}
.filme-controls input[type=range]{-webkit-appearance:none;height:6px;border-radius:999px;background:linear-gradient(90deg,var(--green),var(--blue));outline:none}
.filme-controls input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:var(--surface-2);border:2px solid var(--blue);box-shadow:0 1px 4px rgba(0,39,118,.3);cursor:pointer}
.filme-controls input[type=range]::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:var(--surface-2);border:2px solid var(--blue);cursor:pointer}
.filme-controls input[type=range]:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 4px rgba(0,39,118,.25)}
```
Substitui a regra `.filme-speed button.active{outline:2px solid #002776}` (linha 3857). Sem mudança de JS.

### 12 [optional] de-conflict do double-write SVG (cursor via translateX)
```css
#filmeCursorRect{transform-box:fill-box;transform-origin:left;will-change:transform}
```
REPLACE o forEach 8211-8216 por:
```js
const baseCursorX=FILME_CHART.padX-1;
if(cursorRect){
  cursorRect.style.transition=sweepMs?`transform ${sweepMs}ms linear`:'none';
  cursorRect.style.transform=`translateX(${(chartX-1-baseCursorX).toFixed(1)}px)`;
}
if(clipRect){
  if(sweepMs){clipRect.style.transition=`width ${sweepMs}ms linear`;clipRect.style.width=`${chartX.toFixed(1)}px`;}
  else{clipRect.style.transition='none';clipRect.setAttribute('width',chartX.toFixed(1));clipRect.style.width=`${chartX.toFixed(1)}px`;}
}
```
(Verificar `transform-box:fill-box` no Safari mobile; senão manter abordagem por atributo x só no cursor.)

## Bloco @media reduced-motion CONSOLIDADO (colar 1x)
```css
@media (prefers-reduced-motion:reduce){
  .filme-row,.filme-row .filme-bar{transition:none !important}
  .filme-row .filme-bar::after,
  .filme-row.is-flowing .filme-bar::after,
  .filme-row.is-live .filme-bar::after{animation:none !important;opacity:0 !important}
  .filme-row.is-live .filme-bar{box-shadow:0 0 0 1.5px rgba(216,58,52,.55) !important}
  .filme-row.filme-overtake,
  .filme-row .filme-bar.goal,
  .filme-delta.show,
  .filme-trend.show{animation:none !important}
  #filmeClipRect,#filmeCursorRect{transition:none !important}
  .filme-chart svg path.filme-line-live{animation:none !important;stroke-dashoffset:0}
  .filme-chart.playing #filmeCursorRect{animation:none !important}
  .filme-speed button,#filmePlayBtn,
  .filme-controls input[type=range]::-webkit-slider-thumb{transition:none !important}
}
```

## newKeyframes
filmeBarFlow, filmeBarLivePulse, filmeOvertake, filmeDeltaIn, filmeTrendPop, filmeGoalPulse, filmeAnts, filmeCursorPulse

## Verificação (no lab-filme.html)
1x play: brilho diagonal viaja E→D só no líder + barras ao vivo; barras paradas sólidas. Resize estreito↔largo enquanto cresce barra: espaçamento/velocidade do brilho CONSTANTE (sem esticar) — checagem anti-distorção #1. Overtake: row sobe com scale ~5% + glow, ▲ e +N entram, NÃO pula pro topo. Gol: ripple + número faz roll-up. 4x no meio: fluxo e transições retemporizam na hora. Chart: ants no dashed + cursor com glow/pulse só tocando. Reduced-motion (DevTools > Rendering): zero movimento, tudo snap, anel vermelho estático nas live, placar/posições finais corretos; toggle no meio do play → auto-pausa.
