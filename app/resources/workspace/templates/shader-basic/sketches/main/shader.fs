/*{
  "DESCRIPTION": "Sketchbench シェーダーモードの最小の例(ISF)",
  "ISFVSN": "2",
  "INPUTS": [
    { "NAME": "speed", "TYPE": "float", "DEFAULT": 1.0, "MIN": 0.0, "MAX": 4.0 },
    { "NAME": "tint", "TYPE": "color", "DEFAULT": [0.62, 0.83, 1.0, 1.0] }
  ]
}*/

void main() {
  vec2 uv = isf_FragNormCoord;
  vec2 p = (gl_FragCoord.xy - 0.5 * RENDERSIZE) / RENDERSIZE.y;
  float r = length(p);
  float w = 0.5 + 0.5 * sin(20.0 * r - TIME * speed * 4.0);
  gl_FragColor = vec4(tint.rgb * w * (1.0 - r), 1.0) + vec4(uv * 0.1, 0.0, 0.0);
}
