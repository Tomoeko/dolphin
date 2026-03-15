// main.js

const canvas = document.getElementById('glcanvas');
canvas.width = 640;
canvas.height = 360;
const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
const statusPanel = document.getElementById('statusPanel');
const wireframeToggle = document.getElementById('wireframeToggle');
const tabRenderer = document.getElementById('tabRenderer');
const tabComparison = document.getElementById('tabComparison');
const rendererContent = document.getElementById('rendererContent');
const comparisonContent = document.getElementById('comparisonContent');
const referenceImg = document.getElementById('referenceImg');
const refImgStatus = document.getElementById('refImgStatus');
const overlayLayer = document.getElementById('overlayLayer');
const logAlignmentsBtn = document.getElementById('logAlignments');
const comparisonContainer = document.getElementById('comparisonContainer');
const comparisonViewWrapper = document.getElementById('comparisonViewWrapper');
const resetZoomBtn = document.getElementById('resetZoom');
const coordReadout = document.getElementById('coordReadout');
const pixelColorReadout = document.getElementById('pixelColor');

let currentZoom = 1.0;
let currentPanX = 0;
let currentPanY = 0;
let isPanning = false;
let startX, startY;
let currentSelectedAddr = null;

function updateTransform() {
    // We use translate then scale. For zoom-to-cursor, we adjust pan during the wheel event.
    comparisonViewWrapper.style.transform = `translate(${currentPanX}px, ${currentPanY}px) scale(${currentZoom})`;
}

comparisonContainer.addEventListener('wheel', (e) => {
    e.preventDefault();
    
    const rect = comparisonViewWrapper.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Save previous scale
    const oldScale = currentZoom;
    
    // Calculate new scale
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    currentZoom = Math.min(Math.max(0.1, currentZoom + delta), 20.0);
    
    // Adjust pan to keep focal point under cursor
    // The relative mouse position inside the scaled wrapper is (mouseX / oldScale)
    // We want to keep this point at the same visual position.
    const ratio = (currentZoom / oldScale) - 1;
    currentPanX -= mouseX * ratio;
    currentPanY -= mouseY * ratio;

    updateTransform();
}, { passive: false });

// Panning Implementation
comparisonContent.addEventListener('mousedown', (e) => {
    // Only pan if we click the container or image, not an overlay
    if (e.target === comparisonContainer || e.target === referenceImg || e.target === overlayLayer || e.target === comparisonContent) {
        isPanning = true;
        startX = e.clientX - currentPanX;
        startY = e.clientY - currentPanY;
        comparisonContent.style.cursor = 'grabbing';
    }
});

window.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    currentPanX = e.clientX - startX;
    currentPanY = e.clientY - startY;
    updateTransform();
});

window.addEventListener('mouseup', () => {
    isPanning = false;
    comparisonContent.style.cursor = '';
});

resetZoomBtn.addEventListener('click', () => {
    currentZoom = 1.0;
    currentPanX = 0;
    currentPanY = 0;
    updateTransform();
});

logAlignmentsBtn.addEventListener('click', () => {
    const overlays = overlayLayer.querySelectorAll('.texture-overlay');
    const logs = Array.from(overlays).map(ov => {
        const metadata = JSON.parse(ov.dataset.metadata || '{}');
        const { src, ...metaWithoutSrc } = metadata;
        
        // Native coordinate calculations (Locked to target 640x528)
        const nativeW = 640;
        const nativeH = 528;
        
        // We assume the container's contents are intended to be a 640x528 grid.
        // If the container itself is shrunk (e.g. 360px high), we still want 
        // a 1:1 mapping if the user is dragging in a 640x528 context.
        // The most robust way is to use the style values directly if they were set in a 640x528 space.
        const nl = Math.round(parseInt(ov.style.left));
        const nt = Math.round(parseInt(ov.style.top));
        const nw = Math.round(parseInt(ov.style.width));
        const nh = Math.round(parseInt(ov.style.height));

        return {
            texture: metaWithoutSrc, 
            screenPosition: {
                x: parseInt(ov.style.left),
                y: parseInt(ov.style.top),
                w: parseInt(ov.style.width),
                h: parseInt(ov.style.height)
            },
            nativePosition: {
                x: nl,
                y: nt,
                w: nw,
                h: nh
            },
            scale: {
                x: (parseInt(ov.style.width) / metadata.w).toFixed(2),
                y: (parseInt(ov.style.height) / metadata.h).toFixed(2)
            }
        };
    });
    console.log('[Detailed Alignment Report]', JSON.stringify(logs, null, 2));
    alert('Detailed alignment data logged to console!');
});

// Tab Switching
tabRenderer.addEventListener('click', () => {
    tabRenderer.classList.add('active');
    tabComparison.classList.remove('active');
    rendererContent.classList.add('active');
    comparisonContent.classList.remove('active');
});

tabComparison.addEventListener('click', () => {
    tabComparison.classList.add('active');
    tabRenderer.classList.remove('active');
    comparisonContent.classList.add('active');
    rendererContent.classList.remove('active');
    
    // Auto-load reference image if not already loaded
    if (referenceImg.style.display === 'none') {
        checkAndLoadReference();
    }
});

function selectTextureByAddress(addrHex) {
    if (!addrHex) return;
    currentSelectedAddr = addrHex.toUpperCase();
    const cardId = `tex-card-${currentSelectedAddr}`;
    
    // Update Inspector List
    const allCards = document.querySelectorAll('.texture-card');
    allCards.forEach(c => c.classList.remove('selected'));
    
    const card = document.getElementById(cardId);
    if (card) {
        card.classList.add('selected');
        card.scrollIntoView({ behavior: 'instant', block: 'nearest' });
    }

    updateSelectedHighlights();
}

function updateSelectedHighlights() {
    // 1. Update Comparison Overlays
    const overlays = document.querySelectorAll('.texture-overlay');
    overlays.forEach(ov => {
        const meta = JSON.parse(ov.dataset.metadata || '{}');
        if (meta.addr === currentSelectedAddr) {
            ov.classList.add('selected');
        } else {
            ov.classList.remove('selected');
        }
    });

    // 2. Update Renderer Overlay (SVG)
    const svg = document.getElementById('rendererOverlay');
    svg.innerHTML = '';
    
    if (currentSelectedAddr) {
        const matches = rendererPrimitives.filter(p => p.addr === currentSelectedAddr);
        
        // Deduplicate boxes to avoid "double lines" from overlapping primitives
        const uniqueBoxes = new Set();
        matches.forEach(p => {
            const [x1, y1, x2, y2] = p.bbox.map(n => Math.round(n));
            const key = `${x1},${y1},${x2},${y2}`;
            if (uniqueBoxes.has(key)) return;
            uniqueBoxes.add(key);

            const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            rect.setAttribute("x", x1);
            rect.setAttribute("y", y1);
            rect.setAttribute("width", x2 - x1);
            rect.setAttribute("height", y2 - y1);
            rect.setAttribute("class", "selection-highlight");
            svg.appendChild(rect);
        });
    }
}

let rendererPrimitives = []; // Array of { bbox: [minX, minY, maxX, maxY], addr: "..." }

canvas.addEventListener('click', (e) => {
    if (!tabRenderer.classList.contains('active')) return;
    const rect = canvas.getBoundingClientRect();
    
    // FIX: Scale click coordinates to match internal 640x360 resolution
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    
    // Primitives are stored in render order. Check from top-most (last drawn)
    for (let i = rendererPrimitives.length - 1; i >= 0; i--) {
        const p = rendererPrimitives[i];
        if (x >= p.bbox[0] && x <= p.bbox[2] && y >= p.bbox[1] && y <= p.bbox[3]) {
            if (p.addr) {
                selectTextureByAddress(p.addr);
                return;
            }
        }
    }
    
    // Clicked empty space
    currentSelectedAddr = null;
    updateSelectedHighlights();
    document.querySelectorAll('.texture-card').forEach(c => c.classList.remove('selected'));
});

function checkAndLoadReference() {
    const syncHeight = () => {
        const container = document.getElementById('comparisonContainer');
        // Force 360px height for the 16:9 workspace regardless of image natural size
        container.style.height = `360px`;
        container.style.minHeight = `360px`;
    };

    referenceImg.onload = () => {
        refImgStatus.style.display = 'none';
        referenceImg.style.display = 'block';
        syncHeight();
    };
    referenceImg.onerror = () => {
        if (referenceImg.src.includes('data/ground_truth.png')) {
            console.log('ground_truth.png not found, falling back to HomeMenuFIFO_Frame1.png');
            referenceImg.src = 'data/HomeMenuFIFO_Frame1.png';
        } else {
            refImgStatus.innerText = 'Reference image not found in data/.';
        }
    };
    
    // Force a reload trigger to ensure events fire
    const currentSrc = referenceImg.src;
    referenceImg.src = "";
    referenceImg.src = currentSrc;

    // Initial check
    if (referenceImg.complete && referenceImg.naturalWidth > 0) {
        referenceImg.style.display = 'block';
        refImgStatus.style.display = 'none';
        syncHeight();
    }
}

// Pixel Inspector Implementation
const pickingCanvas = document.createElement('canvas');
const pickingCtx = pickingCanvas.getContext('2d', { willReadFrequently: true });

comparisonContainer.addEventListener('mousemove', (e) => {
    const rect = referenceImg.getBoundingClientRect();
    const x = (e.clientX - rect.left) / currentZoom;
    const y = (e.clientY - rect.top) / currentZoom;
    
    // Reference image is assumed to be 640x528 (native GX resolution for this frame)
    const nativeW = 640;
    const nativeH = 360;
    
    // Scale from container pixels to native pixels
    const nx = Math.round((x / referenceImg.clientWidth) * nativeW);
    const ny = Math.round((y / referenceImg.clientHeight) * nativeH);
    
    if (nx >= 0 && nx < nativeW && ny >= 0 && ny < nativeH) {
        coordReadout.innerText = `X: ${nx}, Y: ${ny} (Native)`;
        
        // Update picking canvas if size changed or first run
        if (pickingCanvas.width !== referenceImg.naturalWidth) {
            pickingCanvas.width = referenceImg.naturalWidth;
            pickingCanvas.height = referenceImg.naturalHeight;
            pickingCtx.drawImage(referenceImg, 0, 0);
        }

        try {
            const px = Math.floor((nx / nativeW) * referenceImg.naturalWidth);
            const py = Math.floor((ny / nativeH) * referenceImg.naturalHeight);
            const pixel = pickingCtx.getImageData(px, py, 1, 1).data;
            const hex = "#" + ((1 << 24) + (pixel[0] << 16) + (pixel[1] << 8) + pixel[2]).toString(16).slice(1).toUpperCase();
            pixelColorReadout.innerText = `Color: ${hex} (R:${pixel[0]} G:${pixel[1]} B:${pixel[2]})`;
            pixelColorReadout.style.color = hex;
        } catch(err) {
            // Handle cross-origin or unloaded image
        }
    }
});
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
        this.posMatrices = new Float32Array(1024); // Support full 64 matrices + overhead
        this.projectionMatrix = mat4.create();
        this.viewport = { wd: 320, ht: 180, xOrig: 320, yOrig: 180 }; // Default 640x360 center
        this.projectionType = 1; // 0=Persp, 1=Ortho
        mat4.ortho(this.projectionMatrix, 0, 640, 360, 0, -1000, 1000); // Default
    }
    reset() {
        this.posMatrices.fill(0);
        this.viewport = { wd: 320, ht: 180, xOrig: 320, yOrig: 180 };
        this.projectionType = 1;
        mat4.ortho(this.projectionMatrix, 0, 640, 360, 0, -1000, 1000);
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
                    // CMPR uses 8x8 tiles, each containing 4 sub-blocks of 4x4 in Z-order
                    const tilesX = Math.floor((width + 7) / 8);
                    const tilesY = Math.floor((height + 7) / 8);

                    for (let sb = 0; sb < 4; sb++) {
                        const subX = (sb & 1) * 4;
                        const subY = (sb >> 1) * 4;

                        // Each sub-block is 8 bytes
                        const c1 = (src[srcOffset] << 8) | src[srcOffset + 1];
                        const c2 = (src[srcOffset + 2] << 8) | src[srcOffset + 3];
                        srcOffset += 4;

                        // Bit-accurate color expansion (565 to 888)
                        const r1 = (c1 >> 11) & 0x1F;
                        const g1 = (c1 >> 5) & 0x3F;
                        const b1 = c1 & 0x1F;
                        const R1 = (r1 << 3) | (r1 >> 2);
                        const G1 = (g1 << 2) | (g1 >> 4);
                        const B1 = (b1 << 3) | (b1 >> 2);

                        const r2 = (c2 >> 11) & 0x1F;
                        const g2 = (c2 >> 5) & 0x3F;
                        const b2 = c2 & 0x1F;
                        const R2 = (r2 << 3) | (r2 >> 2);
                        const G2 = (g2 << 2) | (g2 >> 4);
                        const B2 = (b2 << 3) | (b2 >> 2);

                        // Wii GX interpolation math: ((v1 * 3 + v2 * 5) >> 3)
                        const blend = (v1, v2) => (v1 * 3 + v2 * 5) >> 3;
                        const colors = [];

                        if (c1 > c2) {
                            colors[0] = [R1, G1, B1, 255];
                            colors[1] = [R2, G2, B2, 255];
                            colors[2] = [blend(R2, R1), blend(G2, G1), blend(B2, B1), 255];
                            colors[3] = [blend(R1, R2), blend(G1, G2), blend(B1, B2), 255];
                        } else {
                            colors[0] = [R1, G1, B1, 255];
                            colors[1] = [R2, G2, B2, 255];
                            const avgR = (R1 + R2) >> 1;
                            const avgG = (G1 + G2) >> 1;
                            const avgB = (B1 + B2) >> 1;
                            colors[2] = [avgR, avgG, avgB, 255];
                            colors[3] = [0, 0, 0, 0]; // Hardware transparent (Black with Alpha 0)
                        }

                        for (let ty = 0; ty < 4; ty++) {
                            const row = src[srcOffset++];
                            for (let tx = 0; tx < 4; tx++) {
                                const px = bx * 8 + subX + tx;
                                const py = by * 8 + subY + ty;
                                if (px < width && py < height) {
                                    const pixIdx = (row >> (6 - tx * 2)) & 0x3;
                                    const dstOffset = (py * width + px) * 4;
                                    const c = colors[pixIdx];
                                    dst[dstOffset + 0] = c[0];
                                    dst[dstOffset + 1] = c[1];
                                    dst[dstOffset + 2] = c[2];
                                    dst[dstOffset + 3] = c[3];
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
        card.draggable = true; // Make the whole card draggable to prevent misclicks
        
        card.addEventListener('click', (e) => {
            e.stopPropagation();
            selectTextureByAddress(addrHex);
        });

        // Add drag start listener to the card
        card.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('texData', JSON.stringify({
                addr: addrHex,
                src: dataUrl,
                w: tex.width,
                h: tex.height,
                format: formatName,
                unit: unitIndex
            }));
        });

        list.appendChild(card);
    }

    if (currentSelectedAddr === addrHex) {
        card.classList.add('selected');
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
        let text = `Texture @ 0x${addrHex}\nResolution: ${tex.width}x${tex.height}\nFormat: ${formatName}\nLast Unit: ${unitIndex}`;
        
        // Find Renderer Positions
        const renPrims = rendererPrimitives.filter(p => p.addr === addrHex);
        if (renPrims.length > 0) {
            text += `\n\n[Renderer Tab] Found ${renPrims.length} occurrences:`;
            renPrims.forEach((p, idx) => {
                const [x1, y1, x2, y2] = p.bbox.map(v => Math.round(v));
                text += `\n  - Item ${idx + 1}: BBox(${x1}, ${y1}, ${x2}, ${y2})`;
            });
        }

        // Find Comparison Positions
        const overlays = Array.from(overlayLayer.querySelectorAll('.texture-overlay')).filter(ov => {
            const meta = JSON.parse(ov.dataset.metadata || '{}');
            return meta.addr === addrHex;
        });

        if (overlays.length > 0) {
            text += `\n\n[Comparison Tab] Found ${overlays.length} overlays:`;
            overlays.forEach((ov, idx) => {
                const nl = Math.round(parseInt(ov.style.left));
                const nt = Math.round(parseInt(ov.style.top));
                const nw = Math.round(parseInt(ov.style.width));
                const nh = Math.round(parseInt(ov.style.height));
                text += `\n  - Item ${idx + 1}: ${nw}x${nh} @ ${nl},${nt}`;
            });
        }

        navigator.clipboard.writeText(text).then(() => {
            const btn = document.getElementById(`copy-${addrHex}`);
            const oldText = btn.innerText;
            btn.innerText = 'Copied!';
            btn.classList.add('success');
            setTimeout(() => {
                btn.innerText = oldText;
                btn.classList.remove('success');
            }, 1500);
        }).catch(err => {
            console.error('Failed to copy info:', err);
            alert('Clipboard copy failed. Check console for data.');
            console.log(text);
        });
    });
}

// Comparison View Overlay Logic
overlayLayer.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
});

overlayLayer.addEventListener('drop', (e) => {
    e.preventDefault();
    const rawData = e.dataTransfer.getData('texData');
    if (!rawData) return;
    const data = JSON.parse(rawData);

    const rect = overlayLayer.getBoundingClientRect();
    // Compensate for CSS transform scale
    const x = (e.clientX - rect.left) / currentZoom;
    const y = (e.clientY - rect.top) / currentZoom;

    createOverlay(data, x, y);
});

// Global Drag State for Overlays
let activeOverlay = null;
let activeOverlayData = null;
let isMovingOverlay = false;
let isResizingOverlay = false;
let overlayStartX = 0, overlayStartY = 0;
let overlayStartLeft = 0, overlayStartTop = 0;
let overlayStartW = 0, overlayStartH = 0;
let overlayRAFScheduled = false;
let overlayLatestClientX = 0;
let overlayLatestClientY = 0;

window.addEventListener('mousemove', (e) => {
    if (!isMovingOverlay && !isResizingOverlay) return;
    
    overlayLatestClientX = e.clientX;
    overlayLatestClientY = e.clientY;

    if (overlayRAFScheduled) return;
    overlayRAFScheduled = true;

    requestAnimationFrame(() => {
        overlayRAFScheduled = false;
        if (!activeOverlay) return;

        if (isMovingOverlay) {
            const dx = (overlayLatestClientX - overlayStartX) / currentZoom;
            const dy = (overlayLatestClientY - overlayStartY) / currentZoom;
            const newLeft = overlayStartLeft + dx;
            const newTop = overlayStartTop + dy;
            activeOverlay.style.left = `${newLeft}px`;
            activeOverlay.style.top = `${newTop}px`;
            
            if (activeOverlay.updateLabelFunc) {
                activeOverlay.updateLabelFunc(newLeft, newTop, parseFloat(activeOverlay.style.width), parseFloat(activeOverlay.style.height));
            }
        } else if (isResizingOverlay) {
            const dx = (overlayLatestClientX - overlayStartX) / currentZoom;
            const dy = (overlayLatestClientY - overlayStartY) / currentZoom;
            
            const aspectRatio = activeOverlayData.w / activeOverlayData.h;
            let curW, curH;
            
            if (Math.abs(dx) > Math.abs(dy)) {
                curW = Math.max(10, overlayStartW + dx);
                curH = curW / aspectRatio;
            } else {
                curH = Math.max(10, overlayStartH + dy);
                curW = curH * aspectRatio;
            }
            
            activeOverlay.style.width = `${curW}px`;
            activeOverlay.style.height = `${curH}px`;
            
            if (activeOverlay.updateLabelFunc) {
                activeOverlay.updateLabelFunc(parseFloat(activeOverlay.style.left), parseFloat(activeOverlay.style.top), curW, curH);
            }
        }
    });
});

window.addEventListener('mouseup', () => {
    if (isMovingOverlay || isResizingOverlay) {
        if (activeOverlay && activeOverlayData) {
            console.log(`[Alignment Debug] Texture 0x${activeOverlayData.addr} ${isMovingOverlay ? 'moved' : 'resized'} to X: ${parseInt(activeOverlay.style.left)}, Y: ${parseInt(activeOverlay.style.top)}, W: ${parseInt(activeOverlay.style.width)}, H: ${parseInt(activeOverlay.style.height)}`);
        }
        isMovingOverlay = false;
        isResizingOverlay = false;
        activeOverlay = null;
        activeOverlayData = null;
    }
});

function createOverlay(data, x, y) {
    const overlay = document.createElement('div');
    overlay.className = 'texture-overlay' + (data.addr === currentSelectedAddr ? ' selected' : '');
    overlay.dataset.metadata = JSON.stringify(data); // Store for reporting
    
    // Maintain state for current dimensions
    let curW = Math.round(data.w);
    let curH = Math.round(data.h);
    
    overlay.style.width = `${curW}px`;
    overlay.style.height = `${curH}px`;
    
    // Ensure initial placement stays within bounds if possible, centered on drop
    const left = Math.max(0, x - curW / 2);
    const top = Math.max(0, y - curH / 2);
    overlay.style.left = `${left}px`;
    overlay.style.top = `${top}px`;
    
    // Add Label for debugging coordinates and scale
    const label = document.createElement('div');
    label.className = 'overlay-label';
    const labelLine1 = document.createElement('div');
    const labelLine2 = document.createElement('div');
    labelLine2.style.color = '#fff';
    label.appendChild(labelLine1);
    label.appendChild(labelLine2);
    overlay.appendChild(label);

    let fadeTimer = null;
    const showLabel = () => {
        label.classList.remove('hidden');
        if (fadeTimer) clearTimeout(fadeTimer);
        fadeTimer = setTimeout(() => {
            label.classList.add('hidden');
        }, 2000);
    };

    overlay.addEventListener('mouseenter', showLabel);
    overlay.addEventListener('click', (e) => {
        e.stopPropagation();
        const metadata = JSON.parse(overlay.dataset.metadata);
        if (metadata.addr) {
            selectTextureByAddress(metadata.addr);
        }
        showLabel();
    });
    const updateLabel = (l, t, w, h) => {
        const scaleX = (w / data.w).toFixed(2);
        const scaleY = (h / data.h).toFixed(2);
        
        // Calculate native coordinates (Locked to 640x528)
        const nl = Math.round(l);
        const nt = Math.round(t);
        const nw = Math.round(w);
        const nh = Math.round(h);

        labelLine1.textContent = `Screen: ${Math.round(l)},${Math.round(t)} | ${Math.round(w)}x${Math.round(h)}`;
        labelLine2.textContent = `Native: ${nl},${nt} | ${nw}x${nh} (Scale: ${scaleX}x)`;
        showLabel();
    };
    updateLabel(left, top, curW, curH);

    const img = document.createElement('img');
    img.src = data.src;
    overlay.appendChild(img);

    // Add Resize Handle
    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    overlay.appendChild(handle);

    // Attach updateLabel to the DOM element so the global listener can call it
    overlay.updateLabelFunc = updateLabel;
    
    // Interaction logic
    overlay.addEventListener('mousedown', (e) => {
        if (e.target === handle) return; // Ignore if resizing
        isMovingOverlay = true;
        activeOverlay = overlay;
        activeOverlayData = data;
        overlayStartX = e.clientX;
        overlayStartY = e.clientY;
        overlayStartLeft = parseInt(overlay.style.left);
        overlayStartTop = parseInt(overlay.style.top);
        overlay.style.zIndex = 1000;
        showLabel();
        e.preventDefault();
    });

    handle.addEventListener('mousedown', (e) => {
        isResizingOverlay = true;
        activeOverlay = overlay;
        activeOverlayData = data;
        overlayStartX = e.clientX;
        overlayStartY = e.clientY;
        overlayStartW = parseInt(overlay.style.width);
        overlayStartH = parseInt(overlay.style.height);
        showLabel();
        e.preventDefault();
        e.stopPropagation(); // Don't trigger movement
    });

    overlay.oncontextmenu = (e) => {
        e.preventDefault();
        overlay.remove();
    };

    overlayLayer.appendChild(overlay);
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
    const intView = new Uint32Array(data);
    const floatView = new Float32Array(intView.buffer);
    
    // PosMatrices are at float-based offsets in our JSON stream
    if (addr < 0x1000) { 
        if (addr + count <= 1024) {
            for(let i=0; i<count; i++) {
                XFState.posMatrices[addr + i] = floatView[i];
            }
        }
    } 
    // Viewport is at 0x101a (6 floats: wd, ht, zRange, xOrig, yOrig, farZ)
    else if (addr >= 0x101a && addr <= 0x101f) {
        const offset = addr - 0x101a;
        if (offset === 0) XFState.viewport.wd = floatView[0];
        if (offset <= 1 && offset + floatView.length > 1) XFState.viewport.ht = floatView[1 - offset];
        if (offset <= 3 && offset + floatView.length > 3) XFState.viewport.xOrig = floatView[3 - offset];
        if (offset <= 4 && offset + floatView.length > 4) XFState.viewport.yOrig = floatView[4 - offset];
    }
    // Projection Matrix is at 0x1020 (6 floats + Type at 0x1026)
    else if (addr >= 0x1020 && addr <= 0x1026) {
        const offset = addr - 0x1020;
        if (offset + floatView.length > 6) {
            const type = intView[6 - offset]; // READ AS INT!
            XFState.projectionType = type;
            const p = floatView;
            if (p.length >= 6) {
                const pm = XFState.projectionMatrix;
                if (type === 1) { // Ortho (p0=X scale, p1=X trans, p2=Y scale, p3=Y trans, p4=Z scale, p5=Z trans)
                    pm[0] = p[0]; pm[4] = 0;    pm[8] =  0;   pm[12] = p[1];
                    pm[1] = 0;    pm[5] = p[2]; pm[9] =  0;   pm[13] = p[3];
                    pm[2] = 0;    pm[6] = 0;    pm[10] = p[4];pm[14] = p[5];
                    pm[3] = 0;    pm[7] = 0;    pm[11] = 0;   pm[15] = 1;
                } else if (type === 0) { // Persp (p0=X scale, p1=X trans, p2=Y scale, p3=Y trans, p4=Z scale, p5=Z trans)
                    pm[0] = p[0]; pm[4] = 0;    pm[8] =  p[1]; pm[12] = 0;
                    pm[1] = 0;    pm[5] = p[2]; pm[9] =  p[3]; pm[13] = 0;
                    pm[2] = 0;    pm[6] = 0;    pm[10] = p[4]; pm[14] = p[5];
                    pm[3] = 0;    pm[7] = 0;    pm[11] = -1;   pm[15] = 0;
                }
            }
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
    rendererPrimitives = [];

    const modelViewMatrix = mat4.create();
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
    
    // Ensure highlights are updated after rendererPrimitives is repopulated
    updateSelectedHighlights();

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
    let primaryAddr = null;
    const vcd_init = CPState.vcd[cmd.vat];
    for (let i = 0; i < 8; i++) {
        const hasTex = (i === 0 && vcd_init.Tex0) || (i === 1 && vcd_init.Tex1) || (i === 2 && vcd_init.Tex2) || (i === 3 && vcd_init.Tex3) ||
                      (i === 4 && vcd_init.Tex4) || (i === 5 && vcd_init.Tex5) || (i === 6 && vcd_init.Tex6) || (i === 7 && vcd_init.Tex7);
        if (hasTex) {
            primaryAddr = BPState.textures[i].imageBase.toString(16).toUpperCase();
            boundTex = true;
            break;
        }
    }
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

        // Read Position Matrix Index (1 byte if enabled)
        let posMatIdx = 0;
        if (vcd.PMIdx) {
            posMatIdx = dataView.getUint8(ptr);
            ptr += 1;
        } else {
            // Use MATINDEX_A PosMatIdx (bits 0-5)
            posMatIdx = CPState.matIdxA & 0x3F;
        }
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

        // Resolve ModelView Matrix Index (Already resolved at start of loop)
        // Apply CPState XF ModelView Matrix (3x4 Matrix stored continuously)
        // GX Matrix indices in the vertex or MATINDEX are vector offsets.
        // Each vector is 4 floats. Matrix N is at vector 3*N.
        const mtxBase = posMatIdx * 4;
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

    gl.uniformMatrix4fv(programInfo.uniformLocations.projectionMatrix, false, XFState.projectionMatrix);
    gl.drawArrays(glPrimitive, 0, numVerts);
    
    // Store primitive for selection
    if (boundTex) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const pm = XFState.projectionMatrix;
        const vp = XFState.viewport;

        for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i];
            const y = positions[i+1];
            const z = positions[i+2];

            // Project: ClipSpace = Projection * ModelViewPos
            const cx = pm[0] * x + pm[4] * y + pm[8] * z + pm[12];
            const cy = pm[1] * x + pm[5] * y + pm[9] * z + pm[13];
            const cw = pm[3] * x + pm[7] * y + pm[11] * z + pm[15];

            // Perspective Divide & Viewport Transform
            const ndcX = cx / (cw || 1);
            const ndcY = cy / (cw || 1);

            // Screen Coord (Fixed to WebGL 640x360 canvas space + DOM Y-flip)
            // ndcX = [-1, 1], ndcY = [-1, 1] (WebGL +Y is UP, DOM +Y is DOWN)
            const sx = (ndcX * 0.5 + 0.5) * 640;
            const sy = (-ndcY * 0.5 + 0.5) * 360;

            minX = Math.min(minX, sx);
            minY = Math.min(minY, sy);
            maxX = Math.max(maxX, sx);
            maxY = Math.max(maxY, sy);
        }
        rendererPrimitives.push({
            bbox: [minX, minY, maxX, maxY],
            addr: primaryAddr
        });
    }

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
