// main.js

const canvas = document.getElementById('glcanvas');
const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
const statusPanel = document.getElementById('statusPanel');
const wireframeToggle = document.getElementById('wireframeToggle');

if (!gl) {
    statusPanel.innerText = 'WebGL not supported on this browser!';
    throw new Error('WebGL not supported');
}

let jsonData = null;
let memData = null; // ArrayBuffer
let memUpdates = [];
let drawCalls = 0;
let isWireframe = false;

const FORMAT_NAMES = {
    0x0: "I4", 0x1: "I8", 0x2: "IA4", 0x3: "IA8",
    0x4: "RGB565", 0x5: "RGB5A3", 0x6: "RGBA8",
    0x8: "C4", 0x9: "C8", 0xA: "C14X2", 0xE: "CMPR"
};

// Basic Shaders
const vertexShaderSource = `
    attribute vec4 aVertexPosition;
    attribute vec4 aVertexColor;
    attribute vec2 aVertexTexCoord;
    varying lowp vec4 vColor;
    varying highp vec2 vTexCoord;
    
    uniform mat4 uModelViewMatrix;
    uniform mat4 uProjectionMatrix;

    void main() {
        gl_Position = uProjectionMatrix * uModelViewMatrix * aVertexPosition;
        if (gl_Position.w == 0.0) gl_Position.w = 1.0;
        
        vColor = aVertexColor;
        vTexCoord = aVertexTexCoord;
    }
`;

const fragmentShaderSource = `
    varying lowp vec4 vColor;
    varying highp vec2 vTexCoord;
    uniform sampler2D uSampler;
    uniform int uHasTexture;

    void main() {
        if (uHasTexture == 1) {
            gl_FragColor = vColor * texture2D(uSampler, vTexCoord);
        } else {
            gl_FragColor = vColor;
        }
    }
`;

function loadShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('An error occurred compiling the shaders: ' + gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

const shaderProgram = gl.createProgram();
gl.attachShader(shaderProgram, loadShader(gl, gl.VERTEX_SHADER, vertexShaderSource));
gl.attachShader(shaderProgram, loadShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource));
gl.linkProgram(shaderProgram);

const programInfo = {
    program: shaderProgram,
    attribLocations: {
        vertexPosition: gl.getAttribLocation(shaderProgram, 'aVertexPosition'),
        vertexColor: gl.getAttribLocation(shaderProgram, 'aVertexColor'),
        vertexTexCoord: gl.getAttribLocation(shaderProgram, 'aVertexTexCoord'),
    },
    uniformLocations: {
        projectionMatrix: gl.getUniformLocation(shaderProgram, 'uProjectionMatrix'),
        modelViewMatrix: gl.getUniformLocation(shaderProgram, 'uModelViewMatrix'),
    },
};

const ComponentFormat = {
    UByte: 0, Byte: 1, UShort: 2, Short: 3, Float: 4
};
const FormatSize = {
    [ComponentFormat.UByte]: 1,
    [ComponentFormat.Byte]: 1,
    [ComponentFormat.UShort]: 2,
    [ComponentFormat.Short]: 2,
    [ComponentFormat.Float]: 4
};

class VATGroup {
    constructor() {
        this.PosElements = 0; this.PosFormat = 0; this.PosFrac = 0;
        this.NormalElements = 0; this.NormalFormat = 0;
        this.Color0Elements = 0; this.Color0Comp = 0;
        this.Color1Elements = 0; this.Color1Comp = 0;
        this.Tex0CoordElements = 0; this.Tex0CoordFormat = 0; this.Tex0Frac = 0;
        
        this.Tex1CoordElements = 0; this.Tex1CoordFormat = 0; this.Tex1Frac = 0;
        this.Tex2CoordElements = 0; this.Tex2CoordFormat = 0; this.Tex2Frac = 0;
        this.Tex3CoordElements = 0; this.Tex3CoordFormat = 0; this.Tex3Frac = 0;
        this.Tex4CoordElements = 0; this.Tex4CoordFormat = 0;
        this.Tex4Frac = 0;
        this.Tex5CoordElements = 0; this.Tex5CoordFormat = 0; this.Tex5Frac = 0;
        this.Tex6CoordElements = 0; this.Tex6CoordFormat = 0; this.Tex6Frac = 0;
        this.Tex7CoordElements = 0; this.Tex7CoordFormat = 0; this.Tex7Frac = 0;
    }

    reset() {
        this.PosElements = 0; this.PosFormat = 0; this.PosFrac = 0;
        this.NormalElements = 0; this.NormalFormat = 0;
        this.Color0Elements = 0; this.Color0Comp = 0;
        this.Color1Elements = 0; this.Color1Comp = 0;
        this.Tex0CoordElements = 0; this.Tex0CoordFormat = 0; this.Tex0Frac = 0;
        this.Tex1CoordElements = 0; this.Tex1CoordFormat = 0; this.Tex1Frac = 0;
        this.Tex2CoordElements = 0; this.Tex2CoordFormat = 0; this.Tex2Frac = 0;
        this.Tex3CoordElements = 0; this.Tex3CoordFormat = 0; this.Tex3Frac = 0;
        this.Tex4CoordElements = 0; this.Tex4CoordFormat = 0; this.Tex4Frac = 0;
        this.Tex5CoordElements = 0; this.Tex5CoordFormat = 0; this.Tex5Frac = 0;
        this.Tex6CoordElements = 0; this.Tex6CoordFormat = 0; this.Tex6Frac = 0;
        this.Tex7CoordElements = 0; this.Tex7CoordFormat = 0; this.Tex7Frac = 0;
    }

    parseA(val) {
        this.PosElements = val & 1;
        this.PosFormat = (val >> 1) & 7;
        this.PosFrac = (val >> 4) & 31;
        this.NormalElements = (val >> 9) & 1;
        this.NormalFormat = (val >> 10) & 3;
        this.Color0Elements = (val >> 13) & 1;
        this.Color0Comp = (val >> 14) & 7;
        this.Color1Elements = (val >> 17) & 1;
        this.Color1Comp = (val >> 18) & 7;
        this.Tex0CoordElements = (val >> 21) & 1;
        this.Tex0CoordFormat = (val >> 22) & 7;
        this.Tex0Frac = (val >> 25) & 31;
    }

    parseB(val) {
        this.Tex1CoordElements = val & 1;
        this.Tex1CoordFormat = (val >> 1) & 7;
        this.Tex1Frac = (val >> 4) & 31;
        this.Tex2CoordElements = (val >> 9) & 1;
        this.Tex2CoordFormat = (val >> 10) & 7;
        this.Tex2Frac = (val >> 13) & 31;
        this.Tex3CoordElements = (val >> 18) & 1;
        this.Tex3CoordFormat = (val >> 19) & 7;
        this.Tex3Frac = (val >> 22) & 31;
        this.Tex4CoordElements = (val >> 27) & 1;
        this.Tex4CoordFormat = (val >> 28) & 7;
    }

    parseC(val) {
        this.Tex4Frac = val & 31;
        this.Tex5CoordElements = (val >> 5) & 1;
        this.Tex5CoordFormat = (val >> 6) & 7;
        this.Tex5Frac = (val >> 9) & 31;
        this.Tex6CoordElements = (val >> 14) & 1;
        this.Tex6CoordFormat = (val >> 15) & 7;
        this.Tex6Frac = (val >> 18) & 31;
        this.Tex7CoordElements = (val >> 23) & 1;
        this.Tex7CoordFormat = (val >> 24) & 7;
        this.Tex7Frac = (val >> 27) & 31;
    }
}

class VCD {
    constructor() {
        this.PMIdx = 0; this.T0MIdx = 0; this.T1MIdx = 0; this.T2MIdx = 0;
        this.T3MIdx = 0; this.T4MIdx = 0; this.T5MIdx = 0; this.T6MIdx = 0; this.T7MIdx = 0;
        this.Position = 0; this.Normal = 0; this.Color0 = 0; this.Color1 = 0;
        this.Tex0 = 0; this.Tex1 = 0; this.Tex2 = 0; this.Tex3 = 0;
        this.Tex4 = 0; this.Tex5 = 0; this.Tex6 = 0; this.Tex7 = 0;
    }
    reset() {
        this.PMIdx = 0; this.T0MIdx = 0; this.T1MIdx = 0; this.T2MIdx = 0;
        this.T3MIdx = 0; this.T4MIdx = 0; this.T5MIdx = 0; this.T6MIdx = 0; this.T7MIdx = 0;
        this.Position = 0; this.Normal = 0; this.Color0 = 0; this.Color1 = 0;
        this.Tex0 = 0; this.Tex1 = 0; this.Tex2 = 0; this.Tex3 = 0;
        this.Tex4 = 0; this.Tex5 = 0; this.Tex6 = 0; this.Tex7 = 0;
    }
    parseLO(val) {
        this.PMIdx = val & 1;
        this.T0MIdx = (val >> 1) & 1;
        this.T1MIdx = (val >> 2) & 1;
        this.T2MIdx = (val >> 3) & 1;
        this.T3MIdx = (val >> 4) & 1;
        this.T4MIdx = (val >> 5) & 1;
        this.T5MIdx = (val >> 6) & 1;
        this.T6MIdx = (val >> 7) & 1;
        this.T7MIdx = (val >> 8) & 1;
        this.Position = (val >> 9) & 3;
        this.Normal = (val >> 11) & 3;
        this.Color0 = (val >> 13) & 3;
        this.Color1 = (val >> 15) & 3;
    }
    parseHI(val) {
        this.Tex0 = val & 3;
        this.Tex1 = (val >> 2) & 3;
        this.Tex2 = (val >> 4) & 3;
        this.Tex3 = (val >> 6) & 3;
        this.Tex4 = (val >> 8) & 3;
        this.Tex5 = (val >> 10) & 3;
        this.Tex6 = (val >> 12) & 3;
        this.Tex7 = (val >> 14) & 3;
    }
}

class XFMemory {
    constructor() {
        this.posMatrices = new Float32Array(256); // 0x0000 to 0x00FF
    }
    reset() {
        this.posMatrices.fill(0);
    }
}
const XFState = new XFMemory();

// Texture Decoder Engine
const TexDecoder = {
    getBlockWidth: function(format) {
        if (format === 0x0 || format === 0xE) return 8; // I4, CMPR 
        if (format === 0x1 || format === 0x2) return 8; // I8, IA4
        return 4; // IA8, RGB565, RGB5A3, RGBA8
    },
    getBlockHeight: function(format) {
        if (format === 0x0 || format === 0xE) return 8; // I4, CMPR
        if (format === 0x1 || format === 0x2) return 4; // I8, IA4
        return 4; // IA8, RGB565, RGB5A3, RGBA8
    },
    getBytesPerBlock: function(format) {
        if (format === 0x6) return 64; // RGBA8 uses two 32-byte blocks
        return 32;
    },
    getTextureSize: function(width, height, format) {
        const bw = this.getBlockWidth(format);
        const bh = this.getBlockHeight(format);
        const blocksX = Math.floor((width + bw - 1) / bw);
        const blocksY = Math.floor((height + bh - 1) / bh);
        return blocksX * blocksY * this.getBytesPerBlock(format);
    },
    getMemoryChunk: function(address, size) {
        if (!memData) return null; // memData must be loaded
        for (const update of memUpdates) {
            // Check if address is within this update chunk
            if (address >= update.address && address < update.address + update.size) {
                const offsetInChunk = address - update.address;
                const available = update.size - offsetInChunk;
                const readSize = Math.min(size, available);
                if (readSize < size) {
                    console.warn(`Texture spans multiple chunks or is truncated. Need ${size}, got ${readSize}.`);
                }
                return new Uint8Array(memData, update.offset + offsetInChunk, readSize);
            }
        }
        // console.warn(`Memory chunk not found for address 0x${address.toString(16)}!`);
        return null;
    },

    decode: function(width, height, format, address) {
        const size = this.getTextureSize(width, height, format);
        const src = this.getMemoryChunk(address, size);
        if (!src) return null;

        const dst = new Uint8Array(width * height * 4);
        const bw = this.getBlockWidth(format);
        const bh = this.getBlockHeight(format);
        const bX = Math.floor((width + bw - 1) / bw);
        const bY = Math.floor((height + bh - 1) / bh);

        let srcOffset = 0;

        for (let by = 0; by < bY; by++) {
            for (let bx = 0; bx < bX; bx++) {
                
                if (format === 0x6) { // RGBA8 (Special interleaving: AR block, then GB block)
                    for (let ty = 0; ty < bh; ty++) {
                        for (let tx = 0; tx < bw; tx++) {
                            const px = bx * bw + tx;
                            const py = by * bh + ty;
                            if (px < width && py < height) {
                                const dstOffset = (py * width + px) * 4;
                                const texelOffset = (ty * bw + tx) * 2;
                                dst[dstOffset + 3] = src[srcOffset + texelOffset];     // A
                                dst[dstOffset + 0] = src[srcOffset + texelOffset + 1]; // R
                                dst[dstOffset + 1] = src[srcOffset + 32 + texelOffset];     // G
                                dst[dstOffset + 2] = src[srcOffset + 32 + texelOffset + 1]; // B
                            }
                        }
                    }
                } else if (format === 0x5) { // RGB5A3
                    for (let ty = 0; ty < bh; ty++) {
                        for (let tx = 0; tx < bw; tx++) {
                            const px = bx * bw + tx;
                            const py = by * bh + ty;
                            if (px < width && py < height) {
                                const dstOffset = (py * width + px) * 4;
                                const val = (src[srcOffset] << 8) | src[srcOffset + 1];
                                srcOffset += 2;
                                if (val & 0x8000) { // RGB555
                                    dst[dstOffset + 0] = ((val >> 10) & 0x1F) * (255/31);
                                    dst[dstOffset + 1] = ((val >> 5) & 0x1F) * (255/31);
                                    dst[dstOffset + 2] = (val & 0x1F) * (255/31);
                                    dst[dstOffset + 3] = 255;
                                } else { // RGB4A3
                                    dst[dstOffset + 3] = ((val >> 12) & 0x7) * (255/7);
                                    dst[dstOffset + 0] = ((val >> 8) & 0xF) * (255/15);
                                    dst[dstOffset + 1] = ((val >> 4) & 0xF) * (255/15);
                                    dst[dstOffset + 2] = (val & 0xF) * (255/15);
                                }
                            } else {
                                srcOffset += 2; // skip padding
                            }
                        }
                    }
                    continue; 
                } else if (format === 0x4) { // RGB565
                    for (let ty = 0; ty < bh; ty++) {
                        for (let tx = 0; tx < bw; tx++) {
                            const px = bx * bw + tx;
                            const py = by * bh + ty;
                            if (px < width && py < height) {
                                const dstOffset = (py * width + px) * 4;
                                const val = (src[srcOffset] << 8) | src[srcOffset + 1];
                                srcOffset += 2;
                                dst[dstOffset + 0] = ((val >> 11) & 0x1F) * (255/31);
                                dst[dstOffset + 1] = ((val >> 5) & 0x3F) * (255/63);
                                dst[dstOffset + 2] = (val & 0x1F) * (255/31);
                                dst[dstOffset + 3] = 255;
                            } else {
                                srcOffset += 2;
                            }
                        }
                    }
                    continue; 
                } else if (format === 0x3) { // IA8
                    for (let ty = 0; ty < bh; ty++) {
                        for (let tx = 0; tx < bw; tx++) {
                            const px = bx * bw + tx;
                            const py = by * bh + ty;
                            if (px < width && py < height) {
                                const dstOffset = (py * width + px) * 4;
                                const a = src[srcOffset++];
                                const l = src[srcOffset++];
                                dst[dstOffset + 0] = l;
                                dst[dstOffset + 1] = l;
                                dst[dstOffset + 2] = l;
                                dst[dstOffset + 3] = a;
                            } else {
                                srcOffset += 2;
                            }
                        }
                    }
                    continue; 
                } else if (format === 0x1) { // I8
                    for (let ty = 0; ty < bh; ty++) {
                        for (let tx = 0; tx < bw; tx++) {
                            const px = bx * bw + tx;
                            const py = by * bh + ty;
                            if (px < width && py < height) {
                                const dstOffset = (py * width + px) * 4;
                                const l = src[srcOffset++];
                                dst[dstOffset + 0] = l;
                                dst[dstOffset + 1] = l;
                                dst[dstOffset + 2] = l;
                                dst[dstOffset + 3] = l;
                            } else {
                                srcOffset++;
                            }
                        }
                    }
                    continue; 
                } else if (format === 0x2) { // IA4
                    for (let ty = 0; ty < bh; ty++) {
                        for (let tx = 0; tx < bw; tx++) {
                            const px = bx * bw + tx;
                            const py = by * bh + ty;
                            if (px < width && py < height) {
                                const dstOffset = (py * width + px) * 4;
                                const val = src[srcOffset++];
                                const a = ((val >> 4) & 0xF) * (255/15);
                                const l = (val & 0xF) * (255/15);
                                dst[dstOffset + 0] = l;
                                dst[dstOffset + 1] = l;
                                dst[dstOffset + 2] = l;
                                dst[dstOffset + 3] = a;
                            } else {
                                srcOffset++;
                            }
                        }
                    }
                    continue;
                } else if (format === 0x0) { // I4
                    for (let ty = 0; ty < bh; ty++) {
                        for (let tx = 0; tx < bw; tx += 2) {
                            const val = src[srcOffset++];
                            for (let i = 0; i < 2; i++) {
                                const pix = (i === 0) ? (val >> 4) : (val & 0xF);
                                const px = bx * bw + tx + i;
                                const py = by * bh + ty;
                                if (px < width && py < height) {
                                    const dstOffset = (py * width + px) * 4;
                                    const l = pix * (255/15);
                                    dst[dstOffset + 0] = l;
                                    dst[dstOffset + 1] = l;
                                    dst[dstOffset + 2] = l;
                                    dst[dstOffset + 3] = 255;
                                }
                            }
                        }
                    }
                    continue;
                } else if (format === 0xE) { // CMPR (DXT1)
                    // CMPR uses 8x8 blocks, but internal layout is 4 sub-blocks of 4x4
                    const subBlocks = [
                        { dx: 0, dy: 0 }, { dx: 4, dy: 0 },
                        { dx: 0, dy: 4 }, { dx: 4, dy: 4 }
                    ];

                    for (const sb of subBlocks) {
                        const c1 = (src[srcOffset] << 8) | src[srcOffset + 1];
                        const c2 = (src[srcOffset + 2] << 8) | src[srcOffset + 3];
                        srcOffset += 4;

                        const r1 = ((c1 >> 11) & 0x1F) * (255 / 31);
                        const g1 = ((c1 >> 5) & 0x3F) * (255 / 63);
                        const b1 = (c1 & 0x1F) * (255 / 31);

                        const r2 = ((c2 >> 11) & 0x1F) * (255 / 31);
                        const g2 = ((c2 >> 5) & 0x3F) * (255 / 63);
                        const b2 = (c2 & 0x1F) * (255 / 31);

                        const colors = [
                            [r1, g1, b1, 255],
                            [r2, g2, b2, 255]
                        ];

                        if (c1 > c2) {
                            colors.push([
                                (2 * r1 + r2) / 3, (2 * g1 + g2) / 3, (2 * b1 + b2) / 3, 255
                            ]);
                            colors.push([
                                (r1 + 2 * r2) / 3, (g1 + 2 * g2) / 3, (b1 + 2 * b2) / 3, 255
                            ]);
                        } else {
                            colors.push([
                                (r1 + r2) / 2, (g1 + g2) / 2, (b1 + b2) / 2, 255
                            ]);
                            colors.push([0, 0, 0, 0]); // Transparent black
                        }

                        for (let ty = 0; ty < 4; ty++) {
                            const row = src[srcOffset++];
                            for (let tx = 0; tx < 4; tx++) {
                                const pixIdx = (row >> (6 - tx * 2)) & 0x3;
                                const px = bx * bw + sb.dx + tx;
                                const py = by * bh + sb.dy + ty;
                                if (px < width && py < height) {
                                    const dstOffset = (py * width + px) * 4;
                                    dst[dstOffset + 0] = colors[pixIdx][0];
                                    dst[dstOffset + 1] = colors[pixIdx][1];
                                    dst[dstOffset + 2] = colors[pixIdx][2];
                                    dst[dstOffset + 3] = colors[pixIdx][3];
                                }
                            }
                        }
                    }
                    continue;
                } else {
                    // Fallback mock colors for unsupported formats
                    srcOffset += this.getBytesPerBlock(format);
                }

                if (format === 0x6) {
                    srcOffset += 64; // RGBA8 advances 64 bytes per block
                }
            }
        }
        return dst;
    }
};

function resetTextureInspector() {
    const list = document.getElementById('textureList');
    list.innerHTML = '<div class="empty-state">No textures decoded yet.</div>';
}

function createTextureThumbnail(rgba8, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(width, height);
    imageData.data.set(rgba8);
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL();
}

function addTextureToInspector(unitIndex, rgba8) {
    const tex = BPState.textures[unitIndex];
    const list = document.getElementById('textureList');
    const addrHex = tex.imageBase.toString(16).toUpperCase();
    const cardId = `tex-card-${addrHex}`;
    
    // Remove empty state if present
    const emptyState = list.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    // Check if we already have a card for this unique texture address
    let card = document.getElementById(cardId);
    if (!card) {
        card = document.createElement('div');
        card.id = cardId;
        card.className = 'texture-card';
        list.appendChild(card);
    }

    const formatName = FORMAT_NAMES[tex.format] || `0x${tex.format.toString(16)}`;
    const dataUrl = createTextureThumbnail(rgba8, tex.width, tex.height);

    card.innerHTML = `
        <div class="texture-thumb-container">
            <img class="texture-thumb" src="${dataUrl}" alt="Texture 0x${addrHex}">
        </div>
        <div class="texture-info">
            <div class="texture-name">Texture @ 0x${addrHex}</div>
            <div class="texture-meta">Res: ${tex.width} x ${tex.height}</div>
            <div class="texture-meta">Format: ${formatName}</div>
            <div class="texture-meta">Last Unit: ${unitIndex}</div>
            <button class="copy-btn" id="copy-${addrHex}">Copy Info</button>
        </div>
    `;

    document.getElementById(`copy-${addrHex}`).addEventListener('click', () => {
        const text = `Texture @ 0x${addrHex}\nResolution: ${tex.width}x${tex.height}\nFormat: ${formatName}\nLast Unit: ${unitIndex}`;
        navigator.clipboard.writeText(text).then(() => {
            const btn = document.getElementById(`copy-${addrHex}`);
            const oldText = btn.innerText;
            btn.innerText = 'Copied!';
            btn.classList.add('success');
            setTimeout(() => {
                btn.innerText = oldText;
                btn.classList.remove('success');
            }, 2000);
        });
    });
}

class BPTextureUnit {
    constructor() {
        this.width = 0;
        this.height = 0;
        this.format = 0;
        this.imageBase = 0;
        this.webglTexture = null;
        this.dirty = false;
    }
    reset() {
        this.width = 0;
        this.height = 0;
        this.format = 0;
        this.imageBase = 0;
        this.dirty = false;
    }
}

class BPMemory {
    constructor() {
        this.textures = Array(8).fill(null).map(() => new BPTextureUnit());
    }
    reset() {
        this.textures.forEach(t => t.reset());
    }
}
const BPState = new BPMemory();

class CPStateTracker {
    constructor() {
        this.vat = Array(8).fill(null).map(() => new VATGroup());
        this.vcd = Array(8).fill(null).map(() => new VCD());
        this.matIdxA = 0; 
    }
    reset() {
        this.vat.forEach(v => v.reset());
        this.vcd.forEach(v => v.reset());
        this.matIdxA = 0;
    }
}
const CPState = new CPStateTracker();

// UI Handlers
document.getElementById('jsonInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    document.getElementById('jsonLabel').innerText = file.name;
    statusPanel.innerText = 'Parsing JSON...';
    
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            jsonData = JSON.parse(e.target.result);
            memUpdates = jsonData[0].memory_updates; // Extract memory updates from the first frame
            statusPanel.innerText = 'JSON Loaded. ' + jsonData.length + ' frames found.';
            tryRender();
        } catch (err) {
            statusPanel.innerText = 'Error parsing JSON: ' + err.message;
        }
    };
    reader.readAsText(file);
});

document.getElementById('memInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    document.getElementById('memLabel').innerText = file.name;
    statusPanel.innerText = 'Loading MEM...';
    
    const reader = new FileReader();
    reader.onload = (e) => {
        memData = e.target.result;
        statusPanel.innerText = 'MEM Loaded (' + (memData.byteLength / 1024 / 1024).toFixed(2) + ' MB).';
        tryRender();
    };
    reader.readAsArrayBuffer(file);
});

wireframeToggle.addEventListener('change', (e) => {
    isWireframe = e.target.checked;
    tryRender();
});

function applyCPCommand(cmd, val) {
    if (cmd >= 0x70 && cmd <= 0x77) {
        CPState.vat[cmd - 0x70].parseA(val);
    } else if (cmd >= 0x80 && cmd <= 0x87) {
        CPState.vat[cmd - 0x80].parseB(val);
    } else if (cmd >= 0x90 && cmd <= 0x97) {
        CPState.vat[cmd - 0x90].parseC(val);
    } else if (cmd >= 0x50 && cmd <= 0x57) {
        CPState.vcd[cmd - 0x50].parseLO(val);
    } else if (cmd >= 0x60 && cmd <= 0x67) {
        CPState.vcd[cmd - 0x60].parseHI(val);
    } else if (cmd === 0x30) {
        CPState.matIdxA = val;
    }
}

function applyXFCommand(addr, count, data) {
    // PosMatrices are at 0x0000 - 0x00FF
    if (addr >= 0 && addr + count <= 256) {
        const floatView = new Float32Array(new Uint32Array(data).buffer);
        for(let i=0; i<count; i++) {
            XFState.posMatrices[addr + i] = floatView[i];
        }
    }
}


function applyBPCommand(cmd, val) {
    if (cmd >= 0x88 && cmd <= 0x8B) { // TX_SETIMAGE0 (Tex0-Tex3)
        const unit = cmd - 0x88;
        BPState.textures[unit].width = (val & 0x3FF) + 1;
        BPState.textures[unit].height = ((val >> 10) & 0x3FF) + 1;
        BPState.textures[unit].format = (val >> 20) & 0xF;
        BPState.textures[unit].dirty = true;
    } else if (cmd >= 0xA8 && cmd <= 0xAB) { // TX_SETIMAGE0 (Tex4-Tex7)
        const unit = (cmd - 0xA8) + 4;
        BPState.textures[unit].width = (val & 0x3FF) + 1;
        BPState.textures[unit].height = ((val >> 10) & 0x3FF) + 1;
        BPState.textures[unit].format = (val >> 20) & 0xF;
        BPState.textures[unit].dirty = true;
    } else if (cmd >= 0x94 && cmd <= 0x97) { // TX_SETIMAGE3 (Tex0-Tex3)
        const unit = cmd - 0x94;
        BPState.textures[unit].imageBase = (val & 0xFFFFFF) << 5;
        BPState.textures[unit].dirty = true;
    } else if (cmd >= 0xB4 && cmd <= 0xB7) { // TX_SETIMAGE3 (Tex4-Tex7)
        const unit = (cmd - 0xB4) + 4;
        BPState.textures[unit].imageBase = (val & 0xFFFFFF) << 5;
        BPState.textures[unit].dirty = true;
    }
}

function tryRender() {
    if (!jsonData) return;
    
    // For now, let's just render Frame 0
    const frame = jsonData[0];
    if (!frame) return;

    statusPanel.innerText = 'Rendering Frame 0 (' + frame.commands.length + ' commands)...';

    gl.clearColor(0.1, 0.1, 0.1, 1.0);
    gl.clearDepth(1.0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(programInfo.program);

    // Maintain states
    CPState.reset();
    XFState.reset();
    BPState.reset();
    resetTextureInspector(); 
    drawCalls = 0;

    // Setup an orthographic projection (Wii home menu is often rendered in 2D ortho)
    const projectionMatrix = mat4.create();
    mat4.ortho(projectionMatrix, 0, 640, 528, 0, -1000, 1000);
    
    const modelViewMatrix = mat4.create();

    gl.uniformMatrix4fv(programInfo.uniformLocations.projectionMatrix, false, projectionMatrix);
    gl.uniformMatrix4fv(programInfo.uniformLocations.modelViewMatrix, false, modelViewMatrix);

    let triangles = 0;

    for (const cmd of frame.commands) {
        if (cmd.type === "CP") {
            applyCPCommand(cmd.command, cmd.value);
        } else if (cmd.type === "XF") {
            applyXFCommand(cmd.address, cmd.count, cmd.data);
        } else if (cmd.type === "BP") {
            applyBPCommand(cmd.command, cmd.value);
        } else if (cmd.type === "Primitive") {
            drawPrimitive(cmd);
            drawCalls++;
            // A Triangle strip (primitive=1) creates N-2 triangles
            // Defaulting roughly to triangle fans/strips math
            triangles += Math.max(0, cmd.num_vertices - 2); 
        }
    }

    statusPanel.innerText = `Render Complete!
Draw Calls: ${drawCalls}
Est. Triangles: ${triangles}`;
}

function drawPrimitive(cmd) {
    // GX primitive drawing.
    // We get unindexed data directly from dolphin-tool:
    // array of bytes representing vertex_size per vertex.
    
    if (!cmd.data || cmd.data.length === 0) return;

    // For simplicity without building a full VAT decoder in this MVP,
    // we assume we can cast the raw bytes slightly, OR we just pull X,Y out 
    // of the first 8 bytes if it's floats, or shorts.
    // Dolphin extracted the RAW vertex data into cmd.data.

    // Bind textures and update inspector for all units
    // Note: Emulating TEV stages fully is complex. 
    // We'll decode all units that are dirty and used by the VCD.
    const vcd = CPState.vcd[cmd.vat];
    for (let i = 0; i < 8; i++) {
        const tex = BPState.textures[i];
        const hasTex = (i === 0 && vcd.Tex0) || (i === 1 && vcd.Tex1) || (i === 2 && vcd.Tex2) || (i === 3 && vcd.Tex3) ||
                      (i === 4 && vcd.Tex4) || (i === 5 && vcd.Tex5) || (i === 6 && vcd.Tex6) || (i === 7 && vcd.Tex7);

        if (hasTex && tex.dirty) {
            if (tex.width > 0 && tex.height > 0 && tex.imageBase > 0 && memData) {
                const rgba8 = TexDecoder.decode(tex.width, tex.height, tex.format, tex.imageBase);
                if (rgba8) {
                    if (!tex.webglTexture) tex.webglTexture = gl.createTexture();
                    gl.activeTexture(gl.TEXTURE0 + i);
                    gl.bindTexture(gl.TEXTURE_2D, tex.webglTexture);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tex.width, tex.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba8);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                    
                    addTextureToInspector(i, rgba8);
                    tex.dirty = false;
                }
            }
        }
    }

    let boundTex = false;
    if (vcd.Tex0 && BPState.textures[0].webglTexture) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, BPState.textures[0].webglTexture);
        boundTex = true;
    } else {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, null);
    }

    // Set uniform to tell shader whether we have a texture
    const uHasTexture = gl.getUniformLocation(shaderProgram, 'uHasTexture');
    gl.uniform1i(uHasTexture, boundTex ? 1 : 0);
    
    // Set uSampler to texture unit 0
    const uSampler = gl.getUniformLocation(shaderProgram, 'uSampler');
    gl.uniform1i(uSampler, 0);

    const vertexSize = cmd.vertex_size;
    const numVerts = cmd.num_vertices;
    const positions = [];
    const colors = [];
    const texcoords = [];

    const dataView = new DataView(new Uint8Array(cmd.data).buffer);
    // const vcd = CPState.vcd[cmd.vat]; // Already defined above
    const vat = CPState.vat[cmd.vat];

    // Helper to read a component
    function readComponent(offset, format, frac) {
        let val = 0;
        let size = 0;
        if (format === ComponentFormat.UByte) { val = dataView.getUint8(offset); size = 1; }
        else if (format === ComponentFormat.Byte) { val = dataView.getInt8(offset); size = 1; }
        else if (format === ComponentFormat.UShort) { val = dataView.getUint16(offset, false); size = 2; }
        else if (format === ComponentFormat.Short) { val = dataView.getInt16(offset, false); size = 2; }
        else if (format === ComponentFormat.Float) { val = dataView.getFloat32(offset, false); size = 4; }
        
        if (format !== ComponentFormat.Float) {
            val = val / (1 << frac);
        }
        return { val, size };
    }

    // Helper to read Color
    function readColor(offset, format) {
        let r=255, g=255, b=255, a=255;
        let size = 0;
        if (format === 0) { // RGB565
            const val = dataView.getUint16(offset, false);
            r = ((val >> 11) & 0x1F) * (255/31);
            g = ((val >> 5) & 0x3F) * (255/63);
            b = (val & 0x1F) * (255/31);
            size = 2;
        } else if (format === 1) { // RGB888
            r = dataView.getUint8(offset);
            g = dataView.getUint8(offset+1);
            b = dataView.getUint8(offset+2);
            size = 3;
        } else if (format === 2) { // RGB888x
            r = dataView.getUint8(offset);
            g = dataView.getUint8(offset+1);
            b = dataView.getUint8(offset+2);
            size = 4;
        } else if (format === 3) { // RGBA4444
            const val = dataView.getUint16(offset, false);
            r = ((val >> 12) & 0xF) * (255/15);
            g = ((val >> 8) & 0xF) * (255/15);
            b = ((val >> 4) & 0xF) * (255/15);
            a = (val & 0xF) * (255/15);
            size = 2;
        } else if (format === 4) { // RGBA6666
            // The real implementation extracts bits from 3 bytes.
            const b0 = dataView.getUint8(offset);
            const b1 = dataView.getUint8(offset+1);
            const b2 = dataView.getUint8(offset+2);
            const combined = (b0 << 16) | (b1 << 8) | b2;
            r = ((combined >> 18) & 0x3F) * (255/63);
            g = ((combined >> 12) & 0x3F) * (255/63);
            b = ((combined >> 6) & 0x3F) * (255/63);
            a = (combined & 0x3F) * (255/63);
            size = 3;
        } else if (format === 5) { // RGBA8888
            r = dataView.getUint8(offset);
            g = dataView.getUint8(offset+1);
            b = dataView.getUint8(offset+2);
            a = dataView.getUint8(offset+3);
            size = 4;
        }
        return { r: r/255, g: g/255, b: b/255, a: a/255, size };
    }

    for (let i = 0; i < numVerts; i++) {
        let ptr = i * vertexSize;
        let x=0, y=0, z=0;
        let r=1, g=1, b=1, a=1;
        let u=0, v=0;

        // Skip Position Matrix Index (1 byte if enabled)
        if (vcd.PMIdx) ptr += 1;
        // Skip Texture Matrix Indices
        if (vcd.T0MIdx) ptr += 1;
        if (vcd.T1MIdx) ptr += 1;
        if (vcd.T2MIdx) ptr += 1;
        if (vcd.T3MIdx) ptr += 1;
        if (vcd.T4MIdx) ptr += 1;
        if (vcd.T5MIdx) ptr += 1;
        if (vcd.T6MIdx) ptr += 1;
        if (vcd.T7MIdx) ptr += 1;

        if (vcd.Position === 1) { // Direct
            const elements = (vat.PosElements === 0) ? 2 : 3;
            const resX = readComponent(ptr, vat.PosFormat, vat.PosFrac); ptr += resX.size;
            const resY = readComponent(ptr, vat.PosFormat, vat.PosFrac); ptr += resY.size;
            x = resX.val; y = resY.val;
            if (elements === 3) {
                const resZ = readComponent(ptr, vat.PosFormat, vat.PosFrac); ptr += resZ.size;
                z = resZ.val;
            }
        }

        if (vcd.Normal === 1) { // Direct
            const elements = (vat.NormalElements === 0) ? 1 : 3;
            for(let j=0; j<elements; j++) { // Normals have 3 components each
                const res = readComponent(ptr, vat.NormalFormat, 0); ptr += res.size; 
                const resY = readComponent(ptr, vat.NormalFormat, 0); ptr += resY.size; 
                const resZ = readComponent(ptr, vat.NormalFormat, 0); ptr += resZ.size; 
            }
        }

        if (vcd.Color0 === 1) { // Direct
            const col = readColor(ptr, vat.Color0Comp);
            r = col.r; g = col.g; b = col.b; a = col.a;
            ptr += col.size;
        }

        if (vcd.Color1 === 1) { // Direct
            const col = readColor(ptr, vat.Color1Comp); ptr += col.size;
        }

        if (vcd.Tex0 === 1) { // Direct
            const elements = (vat.Tex0CoordElements === 0) ? 1 : 2;
            const resS = readComponent(ptr, vat.Tex0CoordFormat, vat.Tex0Frac); ptr += resS.size;
            u = resS.val;
            if (elements === 2) {
                const resT = readComponent(ptr, vat.Tex0CoordFormat, vat.Tex0Frac); ptr += resT.size;
                v = resT.val;
            }
        }
        
        // Skip Tex1-7
        const texVCDs = [vcd.Tex1, vcd.Tex2, vcd.Tex3, vcd.Tex4, vcd.Tex5, vcd.Tex6, vcd.Tex7];
        const texVATs = [
            { el: vat.Tex1CoordElements, fmt: vat.Tex1CoordFormat, frac: vat.Tex1Frac },
            { el: vat.Tex2CoordElements, fmt: vat.Tex2CoordFormat, frac: vat.Tex2Frac },
            { el: vat.Tex3CoordElements, fmt: vat.Tex3CoordFormat, frac: vat.Tex3Frac },
            { el: vat.Tex4CoordElements, fmt: vat.Tex4CoordFormat, frac: vat.Tex4Frac },
            { el: vat.Tex5CoordElements, fmt: vat.Tex5CoordFormat, frac: vat.Tex5Frac },
            { el: vat.Tex6CoordElements, fmt: vat.Tex6CoordFormat, frac: vat.Tex6Frac },
            { el: vat.Tex7CoordElements, fmt: vat.Tex7CoordFormat, frac: vat.Tex7Frac }
        ];

        for(let j=0; j<7; j++) {
            if (texVCDs[j] === 1) {
                const elements = (texVATs[j].el === 0) ? 1 : 2;
                const resS = readComponent(ptr, texVATs[j].fmt, texVATs[j].frac); ptr += resS.size;
                if (elements === 2) {
                    const resT = readComponent(ptr, texVATs[j].fmt, texVATs[j].frac); ptr += resT.size;
                }
            }
        }

        // Resolve ModelView Matrix Index
        let posMatIdx = 0;
        if (vcd.PMIdx) {
            // Read 1-byte PosMatIdx from pointer 
            posMatIdx = dataView.getUint8(ptr - 1); // We already ptr+=1 above
        } else {
            // Use MATINDEX_A PosMatIdx (bits 0-5)
            posMatIdx = CPState.matIdxA & 0x3F;
        }

        // Apply CPState XF ModelView Matrix (3x4 Matrix stored continuously)
        // A 3x4 matrix takes 12 floats in XF memory
        // Dolphin actually addresses them by 3-float vectors in some cases, 
        // but typically PosMatIdx * 12 is the float offset
        const mtxBase = posMatIdx * 12;
        const m00 = XFState.posMatrices[mtxBase + 0], m01 = XFState.posMatrices[mtxBase + 1], m02 = XFState.posMatrices[mtxBase + 2], m03 = XFState.posMatrices[mtxBase + 3];
        const m10 = XFState.posMatrices[mtxBase + 4], m11 = XFState.posMatrices[mtxBase + 5], m12 = XFState.posMatrices[mtxBase + 6], m13 = XFState.posMatrices[mtxBase + 7];
        const m20 = XFState.posMatrices[mtxBase + 8], m21 = XFState.posMatrices[mtxBase + 9], m22 = XFState.posMatrices[mtxBase + 10],m23 = XFState.posMatrices[mtxBase + 11];

        // Perform the 3x4 * vec3 matrix multiplication
        const rx = m00 * x + m01 * y + m02 * z + m03;
        const ry = m10 * x + m11 * y + m12 * z + m13;
        const rz = m20 * x + m21 * y + m22 * z + m23;
        
        positions.push(rx, ry, rz);
        colors.push(r, g, b, a);
        texcoords.push(u, v);
    }

    const posBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
    gl.vertexAttribPointer(programInfo.attribLocations.vertexPosition, 3, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(programInfo.attribLocations.vertexPosition);

    const colorBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colors), gl.STATIC_DRAW);
    gl.vertexAttribPointer(programInfo.attribLocations.vertexColor, 4, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(programInfo.attribLocations.vertexColor);

    const texCoordBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(texcoords), gl.STATIC_DRAW);
    gl.vertexAttribPointer(programInfo.attribLocations.vertexTexCoord, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(programInfo.attribLocations.vertexTexCoord);

    // GX Primitives: 
    // 0 = POINTS, 1 = LINES, 2 = LINE_STRIP, 3 = TRIANGLES, 4 = TRIANGLE_STRIP, ...
    // Note: Dolphin tools Primitive enum often maps:
    // 0: Quads
    // 1: Quads (via translation)
    // 2: Triangles
    // 3: TriangleStrip
    // 4: TriangleFan
    // 5: Lines
    // 6: LineStrip
    // 7: Points
    
    // WebGL doesn't support Quads native, so we'll mock it 
    // by using Triangle Fan or points for now.
    
    let glPrimitive = gl.TRIANGLE_FAN;
    
    if (isWireframe) {
        glPrimitive = gl.LINE_STRIP;
    } else {
        switch (cmd.primitive) {
            case 0: // Quads 
            case 1: glPrimitive = gl.TRIANGLE_FAN; break; // Approximating quads
            case 2: glPrimitive = gl.TRIANGLES; break;
            case 3: glPrimitive = gl.TRIANGLE_STRIP; break;
            case 4: glPrimitive = gl.TRIANGLE_FAN; break;
            case 5: glPrimitive = gl.LINES; break;
            case 6: glPrimitive = gl.LINE_STRIP; break;
            case 7: glPrimitive = gl.POINTS; break;
        }
    }

    gl.drawArrays(glPrimitive, 0, numVerts);
    
    gl.deleteBuffer(posBuffer);
    gl.deleteBuffer(colorBuffer);
    gl.deleteBuffer(texCoordBuffer);
}

// Auto-load data if running from the run_viewer.sh script
window.addEventListener('DOMContentLoaded', () => {
    statusPanel.innerText = 'Checking for auto-extracted data...';
    fetch('data/HomeMenuFIFO_Frame1.json')
        .then(r => {
            if (!r.ok) throw new Error('No auto JSON');
            return r.json();
        })
        .then(data => {
            jsonData = data;
            memUpdates = jsonData[0].memory_updates;
            document.getElementById('jsonLabel').innerText = 'HomeMenuFIFO_Frame1.json (Auto-loaded)';
            return fetch('data/HomeMenuFIFO_Frame1.mem');
        })
        .then(r => {
            if (!r.ok) throw new Error('No auto MEM');
            return r.arrayBuffer();
        })
        .then(data => {
            memData = data;
            document.getElementById('memLabel').innerText = 'HomeMenuFIFO_Frame1.mem (Auto-loaded)';
            statusPanel.innerText = 'Auto-loaded fresh extracted files from dolphin-tool successfully!';
            
            // Short delay so the user sees the success message before rendering overwrites it
            setTimeout(tryRender, 500);
        })
        .catch(e => {
            statusPanel.innerText = 'Waiting for files... Please upload manually.';
            console.log("Auto-load skipped:", e.message);
        });
});
