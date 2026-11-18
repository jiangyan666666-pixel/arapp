#include <metal_stdlib>
using namespace metal;

// The shaders of HandEraser.swift: erase the person (the real hand) from the camera picture and
// put RealityKit's virtual content on top. Read HandEraser.swift first.
//
// Image coordinates: 0..1 over the camera image in the sensor's landscape orientation, origin top
// left; the person mask and its depth (256 x 192) have the same orientation and aspect. View
// coordinates: 0..1 over the target texture (the screen), origin top left.

/// The same layout as EraseParams in HandEraser.swift (16-byte rows).
struct EraseParams {
    float4 viewToImage0; // image x = dot(.xyz, (u, v, 1)) for the view point (u, v)
    float4 viewToImage1; // image y
    float4 mask;         // dilate (mask px), feather (mask px), maxDepth (m, 0 = none), strength 0..1
    float4 misc;         // depthClear, fill mip levels, -, -
    int4 modes;          // view (0 normal 1 mask 2 coverage 3 camera 4 source 5 split), mask mode
                         // (0 alpha, 1 depth), source is linear, target is linear
    int4 has;            // a person mask this frame, person depth this frame, -, -
};

// ARKit's capturedImage is full-range YCbCr (BT.601), as in Apple's ARKit Metal template.
constant float4x4 ycbcrToRGB = float4x4(
    float4(+1.0000f, +1.0000f, +1.0000f, +0.0000f),
    float4(+0.0000f, -0.3441f, +1.7720f, +0.0000f),
    float4(+1.4020f, -0.7141f, +0.0000f, +0.0000f),
    float4(-0.7010f, +0.5291f, -0.8860f, +1.0000f));

static float3 cameraRGB(texture2d<float> y, texture2d<float> cbcr, float2 uv) {
    constexpr sampler s(filter::linear, address::clamp_to_edge);
    float4 ycc = float4(y.sample(s, uv).r, cbcr.sample(s, uv).rg, 1.0f);
    return saturate((ycbcrToRGB * ycc).rgb);
}

static float3 toLinear(float3 c) {
    c = max(c, float3(0.0f));
    return select(pow((c + 0.055f) / 1.055f, float3(2.4f)), c / 12.92f, c <= float3(0.04045f));
}

static float3 toGamma(float3 c) {
    c = max(c, float3(0.0f));
    return select(1.055f * pow(c, float3(1.0f / 2.4f)) - 0.055f, c * 12.92f, c <= float3(0.0031308f));
}

static float2 viewToImage(constant EraseParams &p, float2 uv) {
    float3 h = float3(uv, 1.0f);
    return float2(dot(p.viewToImage0.xyz, h), dot(p.viewToImage1.xyz, h));
}

// --- the mask (at the person mask's own size) ---

/// 1 where a person pixel (nearer than maxDepth, when that is set and the depth is there) lies
/// within `dilate` mask pixels (a disc), else 0.
kernel void eraseDilate(texture2d<float, access::read> person [[texture(0)]],
                        texture2d<float, access::read> personDepth [[texture(1)]],
                        texture2d<float, access::write> out [[texture(2)]],
                        constant EraseParams &p [[buffer(0)]],
                        uint2 gid [[thread_position_in_grid]]) {
    const int W = int(out.get_width());
    const int H = int(out.get_height());
    if (int(gid.x) >= W || int(gid.y) >= H) return;
    const int r = int(p.mask.x);
    const float maxDepth = p.mask.z;
    const bool useDepth = maxDepth > 0.0f && p.has.y != 0;
    const int DW = int(personDepth.get_width());
    const int DH = int(personDepth.get_height());
    float m = 0.0f;
    for (int dy = -r; dy <= r && m == 0.0f; dy++) {
        for (int dx = -r; dx <= r; dx++) {
            if (dx * dx + dy * dy > r * r + r) continue;
            int2 q = int2(gid) + int2(dx, dy);
            if (q.x < 0 || q.y < 0 || q.x >= W || q.y >= H) continue;
            if (person.read(uint2(q)).r < 0.5f) continue;
            if (useDepth) {
                uint2 dq = uint2(min(q.x * DW / W, DW - 1), min(q.y * DH / H, DH - 1));
                float d = personDepth.read(dq).r;
                if (!(d > 0.0f && d < maxDepth)) continue;
            }
            m = 1.0f;
            break;
        }
    }
    out.write(float4(m, 0.0f, 0.0f, 1.0f), gid);
}

/// The dilated mask averaged over a (2 feather + 1)^2 square: a soft edge.
kernel void eraseFeather(texture2d<float, access::read> dilated [[texture(0)]],
                         texture2d<float, access::write> out [[texture(1)]],
                         constant EraseParams &p [[buffer(0)]],
                         uint2 gid [[thread_position_in_grid]]) {
    const int W = int(out.get_width());
    const int H = int(out.get_height());
    if (int(gid.x) >= W || int(gid.y) >= H) return;
    const int f = int(p.mask.y);
    float sum = 0.0f;
    float n = 0.0f;
    for (int dy = -f; dy <= f; dy++) {
        for (int dx = -f; dx <= f; dx++) {
            int2 q = clamp(int2(gid) + int2(dx, dy), int2(0), int2(W - 1, H - 1));
            sum += dilated.read(uint2(q)).r;
            n += 1.0f;
        }
    }
    out.write(float4(sum / n, 0.0f, 0.0f, 1.0f), gid);
}

// --- the fill (pull-push) ---

/// The fill's base level: the camera colour where nothing is erased, with weight 1 in alpha
/// (premultiplied), and 0 where anything is. Its mipmaps (a box filter) then hold, per texel, the
/// average of the known colours times the share of known pixels; pullPush reads them back.
/// Each texel averages four bilinear camera samples (about a 4 x 4 block at 1/4 of the image).
kernel void eraseFillBase(texture2d<float> camY [[texture(0)]],
                          texture2d<float> camCbCr [[texture(1)]],
                          texture2d<float> mask [[texture(2)]],
                          texture2d<float, access::write> out [[texture(3)]],
                          uint2 gid [[thread_position_in_grid]]) {
    const uint W = out.get_width();
    const uint H = out.get_height();
    if (gid.x >= W || gid.y >= H) return;
    constexpr sampler s(filter::linear, address::clamp_to_edge);
    const float2 size = float2(float(W), float(H));
    const float2 uv = (float2(gid) + 0.5f) / size;
    const float2 o = 0.25f / size;
    const float2 a = uv + float2(-o.x, -o.y);
    const float2 b = uv + float2(o.x, -o.y);
    const float2 c = uv + float2(-o.x, o.y);
    const float2 d = uv + float2(o.x, o.y);
    float m = max(max(mask.sample(s, a).r, mask.sample(s, b).r), max(mask.sample(s, c).r, mask.sample(s, d).r));
    if (m > 0.002f) {
        out.write(float4(0.0f), gid);
        return;
    }
    float3 rgb = cameraRGB(camY, camCbCr, a) + cameraRGB(camY, camCbCr, b) + cameraRGB(camY, camCbCr, c) + cameraRGB(camY, camCbCr, d);
    out.write(float4(rgb * 0.25f, 1.0f), gid);
}

/// The hole's colour at image point uv: from the coarsest level down, each level's known colour
/// plus its unknown share times the coarser estimate (f = v.rgb + (1 - v.a) f).
static float3 pullPush(texture2d<float> fill, float2 uv, int levels) {
    constexpr sampler s(filter::linear, mip_filter::nearest, address::clamp_to_edge);
    float4 top = fill.sample(s, uv, level(float(levels - 1)));
    float3 c = top.a > 1e-4f ? top.rgb / top.a : float3(0.5f);
    for (int l = levels - 2; l >= 0; l--) {
        float4 v = fill.sample(s, uv, level(float(l)));
        c = v.rgb + (1.0f - v.a) * c;
    }
    return c;
}

// --- the picture ---

/// One output pixel at view point uv. src: RealityKit's pixel; coverage: how much of it is
/// virtual (alpha mode: src is premultiplied over a clear background; depth mode: src is over
/// RealityKit's own camera picture and coverage is 0 or 1).
static float4 erasePixel(float2 uv, float4 src, float coverage,
                         texture2d<float> camY, texture2d<float> camCbCr,
                         texture2d<float> mask, texture2d<float> fill,
                         constant EraseParams &p) {
    constexpr sampler s(filter::linear, address::clamp_to_edge);
    const int view = p.modes.x;
    const bool depthMode = p.modes.y != 0;
    const bool srcLinear = p.modes.z != 0;
    const bool dstLinear = p.modes.w != 0;
    const float2 img = viewToImage(p, uv);
    const float3 cam = cameraRGB(camY, camCbCr, img);
    float m = p.has.x != 0 ? mask.sample(s, img).r * p.mask.w : 0.0f;
    float3 bg = cam;
    if (m > 0.001f && view != 3) {
        bg = mix(cam, pullPush(fill, img, int(p.misc.y)), m);
    }
    if (view == 1 && m > 0.001f) {
        bg = mix(bg, float3(1.0f, 0.15f, 0.1f), 0.45f); // 'mask': the erased area tinted red
    }
    // compose in the source's space
    const float3 bgW = srcLinear ? toLinear(bg) : bg;
    float3 o;
    if (view == 2) {
        o = float3(coverage); // 'coverage': white = virtual
    } else if (view == 4) {
        o = src.rgb; // 'source': RealityKit's picture as it came
    } else if (view == 5 && uv.x < 0.5f) {
        o = srcLinear ? toLinear(cam) : cam; // 'split': left half our camera, right half RealityKit's
    } else if (view == 5) {
        o = src.rgb;
    } else if (depthMode) {
        o = mix(bgW, src.rgb, coverage);
    } else {
        o = src.rgb + (1.0f - coverage) * bgW;
    }
    if (srcLinear && !dstLinear) {
        o = toGamma(o);
    } else if (!srcLinear && dstLinear) {
        o = toLinear(o);
    }
    return float4(o, 1.0f);
}

static float depthCoverage(depth2d<float> depth, float2 uv, constant EraseParams &p) {
    constexpr sampler n(filter::nearest, address::clamp_to_edge);
    float d = depth.sample(n, uv);
    return fabs(d - p.misc.x) > 1e-6f ? 1.0f : 0.0f;
}

struct EraseVertexOut {
    float4 position [[position]];
    float2 uv;
};

/// One triangle that covers the screen.
vertex EraseVertexOut eraseVertex(uint vid [[vertex_id]]) {
    float2 q = float2(float((vid << 1) & 2), float(vid & 2));
    EraseVertexOut o;
    o.position = float4(q * 2.0f - 1.0f, 0.0f, 1.0f);
    o.uv = float2(q.x, 1.0f - q.y);
    return o;
}

fragment float4 eraseFragmentAlpha(EraseVertexOut in [[stage_in]],
                                   texture2d<float> source [[texture(0)]],
                                   texture2d<float> camY [[texture(1)]],
                                   texture2d<float> camCbCr [[texture(2)]],
                                   texture2d<float> mask [[texture(3)]],
                                   texture2d<float> fill [[texture(4)]],
                                   constant EraseParams &p [[buffer(0)]]) {
    constexpr sampler s(filter::linear, address::clamp_to_edge);
    float4 src = source.sample(s, in.uv);
    return erasePixel(in.uv, src, saturate(src.a), camY, camCbCr, mask, fill, p);
}

fragment float4 eraseFragmentDepth(EraseVertexOut in [[stage_in]],
                                   texture2d<float> source [[texture(0)]],
                                   texture2d<float> camY [[texture(1)]],
                                   texture2d<float> camCbCr [[texture(2)]],
                                   texture2d<float> mask [[texture(3)]],
                                   texture2d<float> fill [[texture(4)]],
                                   depth2d<float> depth [[texture(5)]],
                                   constant EraseParams &p [[buffer(0)]]) {
    constexpr sampler s(filter::linear, address::clamp_to_edge);
    float4 src = source.sample(s, in.uv);
    return erasePixel(in.uv, src, depthCoverage(depth, in.uv, p), camY, camCbCr, mask, fill, p);
}

// The same as compute kernels, for a target that is not a render target.

kernel void eraseKernelAlpha(texture2d<float> source [[texture(0)]],
                             texture2d<float> camY [[texture(1)]],
                             texture2d<float> camCbCr [[texture(2)]],
                             texture2d<float> mask [[texture(3)]],
                             texture2d<float> fill [[texture(4)]],
                             texture2d<float, access::write> target [[texture(6)]],
                             constant EraseParams &p [[buffer(0)]],
                             uint2 gid [[thread_position_in_grid]]) {
    if (gid.x >= target.get_width() || gid.y >= target.get_height()) return;
    constexpr sampler s(filter::linear, address::clamp_to_edge);
    float2 uv = (float2(gid) + 0.5f) / float2(float(target.get_width()), float(target.get_height()));
    float4 src = source.sample(s, uv);
    target.write(erasePixel(uv, src, saturate(src.a), camY, camCbCr, mask, fill, p), gid);
}

kernel void eraseKernelDepth(texture2d<float> source [[texture(0)]],
                             texture2d<float> camY [[texture(1)]],
                             texture2d<float> camCbCr [[texture(2)]],
                             texture2d<float> mask [[texture(3)]],
                             texture2d<float> fill [[texture(4)]],
                             depth2d<float> depth [[texture(5)]],
                             texture2d<float, access::write> target [[texture(6)]],
                             constant EraseParams &p [[buffer(0)]],
                             uint2 gid [[thread_position_in_grid]]) {
    if (gid.x >= target.get_width() || gid.y >= target.get_height()) return;
    constexpr sampler s(filter::linear, address::clamp_to_edge);
    float2 uv = (float2(gid) + 0.5f) / float2(float(target.get_width()), float(target.get_height()));
    float4 src = source.sample(s, uv);
    target.write(erasePixel(uv, src, depthCoverage(depth, uv, p), camY, camCbCr, mask, fill, p), gid);
}

// --- the probe: one frame's facts for the PC ---
//
// Over every 8th pixel of the source: counts[0] samples; [1] alpha < 0.02, [2] between, [3] > 0.98;
// [4] depth == 0, [5] depth == 1, [6] other depth (depth probe only); over the pixels whose depth is
// the clear value (or, without depth, alpha < 0.02): [7] samples, [8..10] the source's rgb,
// [11..13] our camera rgb as decoded, [14..16] the same made linear (sums of 0..255 each).

static void probeAdd(device atomic_uint *counts, uint i, uint v) {
    atomic_fetch_add_explicit(&counts[i], v, memory_order_relaxed);
}

static void probeColour(device atomic_uint *counts, float4 c, texture2d<float> camY, texture2d<float> camCbCr, float2 uv, constant EraseParams &p) {
    float3 cam = cameraRGB(camY, camCbCr, viewToImage(p, uv));
    float3 lin = toLinear(cam);
    float3 src = saturate(c.rgb);
    probeAdd(counts, 7, 1);
    for (uint k = 0; k < 3; k++) {
        probeAdd(counts, 8 + k, uint(src[k] * 255.0f + 0.5f));
        probeAdd(counts, 11 + k, uint(cam[k] * 255.0f + 0.5f));
        probeAdd(counts, 14 + k, uint(lin[k] * 255.0f + 0.5f));
    }
}

kernel void eraseProbeDepth(texture2d<float, access::read> source [[texture(0)]],
                            depth2d<float, access::read> depth [[texture(1)]],
                            texture2d<float> camY [[texture(2)]],
                            texture2d<float> camCbCr [[texture(3)]],
                            device atomic_uint *counts [[buffer(0)]],
                            constant EraseParams &p [[buffer(1)]],
                            uint2 gid [[thread_position_in_grid]]) {
    const uint W = source.get_width();
    const uint H = source.get_height();
    const uint2 px = gid * 8;
    if (px.x >= W || px.y >= H) return;
    float4 c = source.read(px);
    probeAdd(counts, 0, 1);
    probeAdd(counts, c.a < 0.02f ? 1 : (c.a > 0.98f ? 3 : 2), 1);
    uint2 dp = uint2(min(px.x * depth.get_width() / W, depth.get_width() - 1), min(px.y * depth.get_height() / H, depth.get_height() - 1));
    float d = depth.read(dp);
    probeAdd(counts, d == 0.0f ? 4 : (d == 1.0f ? 5 : 6), 1);
    if (fabs(d - p.misc.x) < 1e-6f) {
        probeColour(counts, c, camY, camCbCr, (float2(px) + 0.5f) / float2(float(W), float(H)), p);
    }
}

kernel void eraseProbeColour(texture2d<float, access::read> source [[texture(0)]],
                             texture2d<float> camY [[texture(2)]],
                             texture2d<float> camCbCr [[texture(3)]],
                             device atomic_uint *counts [[buffer(0)]],
                             constant EraseParams &p [[buffer(1)]],
                             uint2 gid [[thread_position_in_grid]]) {
    const uint W = source.get_width();
    const uint H = source.get_height();
    const uint2 px = gid * 8;
    if (px.x >= W || px.y >= H) return;
    float4 c = source.read(px);
    probeAdd(counts, 0, 1);
    probeAdd(counts, c.a < 0.02f ? 1 : (c.a > 0.98f ? 3 : 2), 1);
    if (c.a < 0.02f) {
        probeColour(counts, c, camY, camCbCr, (float2(px) + 0.5f) / float2(float(W), float(H)), p);
    }
}
