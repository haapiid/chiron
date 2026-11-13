// The hero's ground: a dusk sea, drawn by one fragment shader. Sky from night blue down to the last warm light,
// stars that twinkle, a slowly turning moon (img/moon.jpg is NASA's LRO map), two mountain ridges, mist on the horizon,
// and water that mirrors all of it with ripples that lengthen toward the viewer. Driven by continuous time, so it never loops visibly.
// With reduced motion it renders one still frame; without WebGL the CSS gradient behind the canvas stays.
(function dusk() {
  const cv = document.getElementById("dusk");
  if (!cv) return;
  const gl = cv.getContext("webgl", { alpha: false, antialias: false });
  if (!gl) return;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const vs = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }`;
  const fs = `precision highp float;
uniform vec2 res; uniform float t, hz, moonOn; uniform vec3 moon, road; uniform sampler2D map;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
  return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ float v = 0., a = .5; for (int k = 0; k < 5; k++){ v += a*n(p); p = p*2.03 + 17.1; a *= .5; } return v; }
vec2 rot(vec2 v, float a){ float c = cos(a), s = sin(a); return vec2(c*v.x - s*v.y, s*v.x + c*v.y); }
// everything above the waterline; the water asks for it again, upside down
vec3 scene(vec2 p){
  float asp = res.x/res.y, y = clamp((p.y - hz)/(1. - hz), 0., 1.);
  vec3 c = mix(vec3(.105, .14, .215), vec3(.032, .045, .085), smoothstep(.2, 1., y));
  c = mix(vec3(.40, .36, .39), c, smoothstep(0., .36, y));
  float gx = (p.x - .58)*asp, glow = exp(-gx*gx*1.1)*exp(-y*5.);
  c += vec3(.95, .68, .44)*glow*.8;
  // stars: one per cell at most, each with its own pace
  vec2 sp = p*vec2(asp, 1.)*150., id = floor(sp), f = fract(sp) - .5;
  float r = h(id), st = step(.984, r)*(1. - smoothstep(0., .13, length(f + (vec2(h(id + 3.1), h(id + 7.7)) - .5)*.6)));
  c += vec3(.92, .94, 1.)*st*(.5 + .5*sin(t*(.8 + r*2.6) + r*60.))*smoothstep(.1, .45, y)*(.4 + .6*h(id + 1.3));
  // the moon: a sphere wearing the lunar map, turning under a light that stays put
  if (moonOn > .5) {
    vec2 d = (p - moon.xy)*vec2(asp, 1.)/moon.z; float rr = dot(d, d);
    if (rr < 1.) {
      float z = sqrt(1. - rr); vec3 nrm = vec3(d, z), q = nrm;
      q.xy = rot(q.xy, .3); q.xz = rot(q.xz, t*.05);
      vec2 uv = vec2(atan(q.x, q.z)/6.2832 + .5, asin(clamp(q.y, -1., 1.))/3.1416 + .5);
      float D = texture2D(map, vec2(fract(uv.x), 1. - uv.y)).r + .45;
      float diff = clamp(dot(nrm, normalize(vec3(-.55, -.5, .62))), 0., 1.);
      vec3 mc = vec3(.80, .77, .74)*D*(.10 + .95*pow(diff, .85)) + vec3(.95, .80, .62)*pow(1. - z, 3.)*.3;
      c = mix(c, mc, .93*(1. - smoothstep(.975, 1., sqrt(rr))));
    }
  }
  // two ridges, the far one paler
  float e = smoothstep(.5, 1., p.x) + .45*smoothstep(.3, 0., p.x);
  float far = hz + .012 + (.05 + .09*e)*fbm(vec2(p.x*2.4 + 3., 1.));
  float near = hz + .004 + (.02 + .10*smoothstep(.72, 1., p.x))*fbm(vec2(p.x*4.2 + 9., 4.));
  c = mix(c, mix(vec3(.24, .25, .31), vec3(.13, .15, .20), smoothstep(hz, far, p.y)), (1. - smoothstep(far - .002, far + .002, p.y)));
  c = mix(c, mix(vec3(.15, .16, .21), vec3(.055, .07, .105), smoothstep(hz, near, p.y)), (1. - smoothstep(near - .002, near + .002, p.y)));
  // mist lying on the horizon
  float band = exp(-pow((p.y - hz - .012)/.03, 2.));
  c = mix(c, vec3(.66, .60, .60), smoothstep(.35, .9, fbm(vec2(p.x*2.6 - t*.02, p.y*16. + t*.008)))*band*.42);
  return c;
}
void main(){
  vec2 p = gl_FragCoord.xy/res;
  vec3 c;
  if (p.y >= hz) c = scene(p);
  else {
    float d = (hz - p.y)/hz, k = 1./(d + .04);
    float w1 = fbm(vec2(p.x*7. + t*.05, k*1.15 - t*.55)), w2 = fbm(vec2(p.x*15. - t*.07, k*2.3 - t*.9));
    vec2 q = vec2(p.x + ((w1 - .5)*.026 + (w2 - .5)*.01)*(.25 + d*1.6), hz + (hz - p.y)*1.12 + sin(k*2.5 - t*1.5 + w1*6.2832)*.005*(.3 + d));
    c = scene(q)*mix(.86, .46, d) + vec3(.012, .02, .035)*d;
    float gx = (p.x - .58)*res.x/res.y;
    c += vec3(1., .8, .58)*pow(n(vec2(p.x*420., k*9. - t*2.)), 18.)*exp(-gx*gx*2.2)*(.25 + d)*.9;
    // the road: a stone causeway from the near shore to the foot of the moon, its left edge catching the last light
    if (road.z > .5) {
      float xc = mix(road.x, road.y, d), w = .004 + .05*d, side = (p.x - xc)/w;
      vec3 stone = mix(vec3(.46, .40, .37), vec3(.20, .21, .26), smoothstep(0., .9, d));
      stone *= .82 + .36*fbm(vec2(p.x*70., d*46.));
      stone *= 1. - .3*smoothstep(.95, 1., fract(pow(d, .55)*16.));                    // joints between the slabs, closer together far away
      stone += vec3(.42, .30, .19)*smoothstep(.35, 1., -side)*(1. - d*.45);
      stone *= 1. - .4*smoothstep(.7, 1., side);
      float far = smoothstep(0., .035, d);
      c = mix(c, vec3(.03, .04, .06), (1. - smoothstep(1.2, 1.3, side))*step(1., side)*far*.85);   // the shaded flank of the slab
      c = mix(c, stone, (1. - smoothstep(.95, 1., abs(side)))*far);
    }
  }
  c += (h(gl_FragCoord.xy + fract(t)) - .5)*.012;          // a little grain keeps the gradients from banding
  gl_FragColor = vec4(c, 1.);
}`;
  const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
  let prog;
  try { prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(prog); if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog)); }
  catch (e) { console.warn("dusk off:", e.message); return; }
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const pl = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(pl); gl.vertexAttribPointer(pl, 2, gl.FLOAT, false, 0, 0);
  const U = (name) => gl.getUniformLocation(prog, name);
  gl.uniform1i(U("map"), 0); gl.uniform1f(U("moonOn"), 0);

  let on = true, raf = 0; const t0 = performance.now();
  const draw = (now) => { gl.uniform1f(U("t"), still ? 40 : (now - t0) / 1000 + 40); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); };
  const frame = (now) => { draw(now); raf = on && !still ? requestAnimationFrame(frame) : 0; };
  const fit = () => {
    const r = cv.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, r.width < 760 ? 1.5 : 1.25);
    cv.width = Math.max(2, Math.round(r.width * dpr)); cv.height = Math.max(2, Math.round(r.height * dpr));
    gl.viewport(0, 0, cv.width, cv.height);
    const narrow = r.width < 760, hz = narrow ? 0.4 : 0.36;
    gl.uniform2f(U("res"), cv.width, cv.height); gl.uniform1f(U("hz"), hz);
    // the moon sits low, just risen: under the constellation on wide screens, beside it on a phone
    gl.uniform3f(U("moon"), narrow ? 0.74 : 0.6, hz + (narrow ? 0.085 : 0.115), narrow ? 0.05 : 0.088);
    // the road runs from the foot of the moon to the lower right corner (wide screens only: on a phone the text sits there);
    // the walker (.walker in the page) stands on it, a little over a third of the way toward the viewer
    const A = 0.6, B = 1.02, S = 0.36, hero = cv.parentElement;
    gl.uniform3f(U("road"), A, B, narrow ? 0 : 1);
    hero.classList.toggle("has-road", !narrow);
    hero.style.setProperty("--wx", `${((A + (B - A) * S) * r.width).toFixed(1)}px`);
    hero.style.setProperty("--wy", `${(hz * (1 - S) * r.height).toFixed(1)}px`);
    hero.style.setProperty("--wh", `${(r.height * 0.13).toFixed(1)}px`);
    if (still) draw(0);
  };
  fit(); addEventListener("resize", fit);
  const im = new Image();
  im.onload = () => {
    const tex = gl.createTexture(); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, im);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.uniform1f(U("moonOn"), 1); if (still) draw(0);
  };
  im.src = "/img/moon.jpg";
  const wake = () => { if (on && !raf && !still) raf = requestAnimationFrame(frame); };
  if (still) draw(0);
  else {
    new IntersectionObserver(([e]) => { on = e.isIntersecting && !document.hidden; wake(); }).observe(cv);
    document.addEventListener("visibilitychange", () => { on = !document.hidden; wake(); });
    raf = requestAnimationFrame(frame);
  }
  cv.classList.add("on");
})();
