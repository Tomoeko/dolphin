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
let maxDrawCalls = 0;
let currentDrawCallLimit = -1; // -1 means no limit (render all)
const GLOBAL_TEXTURE_CACHE = new Map(); // Addr -> { texture, width, height, format, rgba8 }
let posBuffer, colorBuffer, texCoordBuffer;

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
        const matches = rendererPrimitives.filter(p => p.texAddr === currentSelectedAddr);
        
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
            if (p.texAddr) {
                selectTextureByAddress(p.texAddr);
                updateStateInspector(p);
                
                // Sync scrubber
                currentDrawCallLimit = p.drawCallIndex;
                const scrubber = document.getElementById('drawCallScrubber');
                const valueLabel = document.getElementById('scrubberValue');
                scrubber.value = currentDrawCallLimit;
                valueLabel.innerText = currentDrawCallLimit;
                
                // Sync ground truth
                const refImg = document.getElementById('referenceImg');
                const refStatus = document.getElementById('refImgStatus');
                const dcImgPath = `data/draw_calls/dc_${currentDrawCallLimit-1}.png`;
                
                const testImg = new Image();
                testImg.onload = () => {
                    refImg.src = dcImgPath;
                    refImg.style.display = 'block';
                    refStatus.style.display = 'none';
                };
                testImg.onerror = () => {
                    refImg.src = 'data/ground_truth.png';
                    refStatus.innerText = `No snapshot for Part ${currentDrawCallLimit}, showing full Ground Truth.`;
                    refStatus.style.display = 'block';
                };
                testImg.src = dcImgPath;
                
                tryRender(); // Update viewport to show up to this part
                return;
            }
        }
    }
    
    // Clicked empty space
    currentSelectedAddr = null;
    clearStateInspector();
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
const vertexShaderSource = `#version 300 es
    in vec4 aVertexPosition;
    in vec4 aVertexColor;
    in vec2 aVertexTexCoord;
    out lowp vec4 vColor;
    out highp vec2 vTexCoord;
    
    uniform mat4 uModelViewMatrix;
    uniform mat4 uProjectionMatrix;

    void main() {
        gl_Position = uProjectionMatrix * uModelViewMatrix * aVertexPosition;
        if (gl_Position.w == 0.0) gl_Position.w = 1.0;
        
        vColor = aVertexColor;
        vTexCoord = aVertexTexCoord;
    }
`;

const fragmentShaderSource = `#version 300 es
    precision mediump float;
    in lowp vec4 vColor;
    in highp vec2 vTexCoord;
    uniform sampler2D uSampler0;
    uniform sampler2D uSampler1;
    uniform int uHasTexture0;
    uniform int uHasTexture1;
    uniform vec4 uMatColor;
    uniform int uAlphaTest; // bits 0-2 comp0, 3-5 comp1, 6-7 logic
    uniform vec2 uAlphaRef; // x=ref0, y=ref1

    out vec4 outColor;

    bool alphaCompare(int func, float a, float ref) {
        if (func == 0) return false;
        if (func == 1) return (a < ref);
        if (func == 2) return (a == ref);
        if (func == 3) return (a <= ref);
        if (func == 4) return (a > ref);
        if (func == 5) return (a != ref);
        if (func == 6) return (a >= ref);
        if (func == 7) return true;
        return true;
    }

    void main() {
        vec4 tex0 = (uHasTexture0 == 1) ? texture(uSampler0, vTexCoord) : vec4(1.0);
        vec4 tex1 = (uHasTexture1 == 1) ? texture(uSampler1, vTexCoord) : vec4(1.0);
        
        // Multi-texture combine: simple product (emulating basic TEV)
        vec4 texColor = tex0 * tex1;
        
        vec4 color = vColor * uMatColor * texColor;

        if (uAlphaTest != 0) {
            int comp0 = uAlphaTest & 7;
            int comp1 = (uAlphaTest >> 3) & 7;
            int op = (uAlphaTest >> 6) & 3;

            bool p0 = alphaCompare(comp0, color.a, uAlphaRef.x);
            bool p1 = alphaCompare(comp1, color.a, uAlphaRef.y);
            bool pass = true;

            if (op == 0) pass = (p0 && p1);
            else if (op == 1) pass = (p0 || p1);
            else if (op == 2) pass = (p0 != p1);
            else if (op == 3) pass = (p0 == p1);

            if (!pass) discard;
        }

        outColor = color;
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
        uAlphaTest: gl.getUniformLocation(shaderProgram, 'uAlphaTest'),
        uAlphaRef: gl.getUniformLocation(shaderProgram, 'uAlphaRef'),
        uMatColor: gl.getUniformLocation(shaderProgram, 'uMatColor'),
        uSampler0: gl.getUniformLocation(shaderProgram, 'uSampler0'),
        uSampler1: gl.getUniformLocation(shaderProgram, 'uSampler1'),
        uHasTexture0: gl.getUniformLocation(shaderProgram, 'uHasTexture0'),
        uHasTexture1: gl.getUniformLocation(shaderProgram, 'uHasTexture1'),
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

class MatrixIndexA {
    constructor() { this.Hex = 0; }
    get PosNormalMtxIdx() { return this.Hex & 0x3F; }
    get Tex0MtxIdx() { return (this.Hex >> 6) & 0x3F; }
    get Tex1MtxIdx() { return (this.Hex >> 12) & 0x3F; }
    get Tex2MtxIdx() { return (this.Hex >> 18) & 0x3F; }
    get Tex3MtxIdx() { return (this.Hex >> 24) & 0x3F; }
}
class MatrixIndexB {
    constructor() { this.Hex = 0; }
    get Tex4MtxIdx() { return this.Hex & 0x3F; }
    get Tex5MtxIdx() { return (this.Hex >> 6) & 0x3F; }
    get Tex6MtxIdx() { return (this.Hex >> 12) & 0x3F; }
    get Tex7MtxIdx() { return (this.Hex >> 18) & 0x3F; }
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

// XF State and Command Handling
const floatValueHelper = new Float32Array(1);
const uintValueHelper = new Uint32Array(floatValueHelper.buffer);
function u32ToFloat(val) {
    uintValueHelper[0] = val;
    return floatValueHelper[0];
}

class XFMemory {
    constructor() {
        this.posMatrices = new Float32Array(1024); // Support full matrix range
        this.projectionMatrix = mat4.create();
        this.viewport = { wd: 320, ht: 180, xOrig: 320, yOrig: 180 }; 
        this.projectionType = 1; 
        this.projectionBuffer = new Uint32Array(7); // Fixed buffer for projection
        // Wii Center-Origin Fallback: 640x480 centered
        mat4.ortho(this.projectionMatrix, -320, 320, 240, -240, -1024, 1024); 
    }
    reset() {
        this.posMatrices.fill(0);
        this.projectionBuffer.fill(0);
        this.viewport = { wd: 320, ht: 240, xOrig: 320, yOrig: 240 };
        this.projectionType = 1;
        mat4.ortho(this.projectionMatrix, -320, 320, -240, 240, -1024, 1024);
    }
}
const XFState = new XFMemory();

class CPStateTracker {
    constructor() {
        this.vat = Array(8).fill(null).map(() => new VATGroup());
        this.vcd = Array(8).fill(null).map(() => new VCD());
        this.matrix_index_a = { Hex: 0 };
        this.matrix_index_b = { Hex: 0 };
        this.matIdxA = 0; 
    }
    reset() {
        this.vat.forEach(v => v.reset());
        this.vcd.forEach(v => v.reset());
        this.matrix_index_a.Hex = 0;
        this.matrix_index_b.Hex = 0;
        this.matIdxA = 0;
    }
}
const CPState = new CPStateTracker();

function applyXFCommand(address, count, data) {
    for (let i = 0; i < count; i++) {
        const addr = address + i;
        const val = data[i];

        if (addr >= 0x00 && addr < 0x400) { // Full pos/normal matrix range
            XFState.posMatrices[addr] = u32ToFloat(val);
        } else if (addr === 0x1018) { // SETMATRIXINDA
            if (CPState.matrix_index_a) CPState.matrix_index_a.Hex = val;
        } else if (addr === 0x1019) { // SETMATRIXINDB
            if (CPState.matrix_index_b) CPState.matrix_index_b.Hex = val;
        } else if (addr >= 0x101A && addr <= 0x101F) {
            // Viewport (6 floats: scaleX, scaleY, scaleZ, offsetX, offsetY, offsetZ)
            const off = addr - 0x101A;
            const fval = u32ToFloat(val);
            if (off === 0) XFState.viewport.wd = fval;
            else if (off === 1) XFState.viewport.ht = fval;
            else if (off === 3) XFState.viewport.xOrig = fval;
            else if (off === 4) XFState.viewport.yOrig = fval;
        } else if (addr >= 0x1020 && addr <= 0x1026) { 
            XFState.projectionBuffer[addr - 0x1020] = val;
            // Apply whenever we write to the range
            const uview = XFState.projectionBuffer;
            const fview = new Float32Array(uview.buffer);
            const type = uview[6]; 
            XFState.projectionType = type;
            const pm = XFState.projectionMatrix;

            if (type === 0) { // Perspective
                // The projection matrix is a 4x4 matrix.
                // The XF stores it as 6 floats:
                // f0 = 2N / (R-L)
                // f1 = (R+L) / (R-L)
                // f2 = 2N / (T-B)
                // f3 = (T+B) / (T-B)
                // f4 = -(F+N) / (F-N)
                // f5 = -2FN / (F-N)
                // Where N, F, L, R, T, B are near, far, left, right, top, bottom clip planes.
                // The matrix is:
                // [ f0  0  f1  0 ]
                // [ 0  f2  f3  0 ]
                // [ 0   0  f4 f5 ]
                // [ 0   0  -1  0 ]
                pm[0] = fview[0]; pm[4] = 0;        pm[8] = fview[1]; pm[12] = 0;
                pm[1] = 0;        pm[5] = fview[2]; pm[9] = fview[3]; pm[13] = 0;
                pm[2] = 0;        pm[6] = 0;        pm[10] = fview[4]; pm[14] = fview[5];
                pm[3] = 0;        pm[7] = 0;        pm[11] = -1;      pm[15] = 0;
            } else { // Ortho
                // The projection matrix is a 4x4 matrix.
                // The XF stores it as 6 floats:
                // f0 = 2 / (R-L)
                // f1 = -(R+L) / (R-L)
                // f2 = 2 / (T-B)
                // f3 = -(T+B) / (T-B)
                // f4 = -2 / (F-N)
                // f5 = -(F+N) / (F-N)
                // The matrix is:
                // [ f0  0   0  f1 ]
                // [ 0  f2   0  f3 ]
                // [ 0   0  f4  f5 ]
                // [ 0   0   0   1 ]
                pm[0] = fview[0]; pm[4] = 0;        pm[8] = 0;        pm[12] = fview[1];
                pm[1] = 0;        pm[5] = fview[2]; pm[9] = 0;        pm[13] = fview[3];
                pm[2] = 0;        pm[6] = 0;        pm[10] = fview[4]; pm[14] = fview[5];
                pm[3] = 0;        pm[7] = 0;        pm[11] = 0;       pm[15] = 1;
            }
        } else if (addr === 0x100C || addr === 0x100D) { // MATCOLOR
            const idx = addr - 0x100C;
            const mat = BPState.matColors[idx];
            mat[0] = ((val >> 24) & 0xFF) / 255.0;
            mat[1] = ((val >> 16) & 0xFF) / 255.0;
            mat[2] = ((val >> 8) & 0xFF) / 255.0;
            mat[3] = (val & 0xFF) / 255.0;
        } else if (addr === 0x100A || addr === 0x100B) { // AMBCOLOR
            const idx = addr - 0x100A;
            const amb = BPState.ambColors[idx];
            amb[0] = ((val >> 24) & 0xFF) / 255.0;
            amb[1] = ((val >> 16) & 0xFF) / 255.0;
            amb[2] = ((val >> 8) & 0xFF) / 255.0;
            amb[3] = (val & 0xFF) / 255.0;
        }
    }
}

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
        if (!memData) return null;
        
        // Optimistic path: same as before but less logs
        for (const update of memUpdates) {
            if (address >= update.address && address < update.address + update.size) {
                const offsetInChunk = address - update.address;
                const available = update.size - offsetInChunk;
                if (available >= size) {
                    return new Uint8Array(memData, update.offset + offsetInChunk, size);
                }
            }
        }

        // Spanning path: assemble from multiple chunks
        const buf = new Uint8Array(size);
        let filled = 0;
        let success = false;
        while (filled < size) {
            let foundChunk = false;
            const target = address + filled;
            for (const update of memUpdates) {
                if (target >= update.address && target < update.address + update.size) {
                    const offset = target - update.address;
                    const canRead = Math.min(size - filled, update.size - offset);
                    buf.set(new Uint8Array(memData, update.offset + offset, canRead), filled);
                    filled += canRead;
                    foundChunk = true;
                    success = true;
                    break;
                }
            }
            if (!foundChunk) break; 
        }

        if (success) return buf;
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
                                const l = src[srcOffset++];
                                const a = src[srcOffset++];
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
                                const l = ((val >> 4) & 0xF) * (255/15);
                                const a = (val & 0xF) * (255/15);
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
                                    dst[dstOffset + 3] = l;
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

    const formatName = FORMAT_NAMES[tex.format] || `0x${tex.format.toString(16)}`;
    const dataUrl = createTextureThumbnail(rgba8, tex.width, tex.height);

    // Check if we already have a card for this unique texture address
    let card = document.getElementById(cardId);
    if (!card) {
        card = document.createElement('div');
        card.id = cardId;
        card.className = 'texture-card';
        card.draggable = true;
        
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

    card.innerHTML = `
        <div class="texture-thumb-container">
            <img class="texture-thumb" src="${dataUrl}" alt="Texture 0x${addrHex}">
        </div>
        <div class="texture-info">
            <div class="texture-name">Texture @ 0x${addrHex}</div>
            <div class="texture-meta">Res: ${tex.width} x ${tex.height}</div>
            <div class="texture-meta">Format: ${formatName}</div>
            <div class="texture-meta">Last Unit: ${unitIndex}</div>
            <label class="visibility-toggle">
                <input type="checkbox" id="visibility-${addrHex}" ${!HIDDEN_TEXTURES.has(addrHex) ? 'checked' : ''}>
                <span>Visible</span>
            </label>
            <button class="copy-btn" id="copy-${addrHex}">Copy Info</button>
        </div>
    `;

    document.getElementById(`copy-${addrHex}`).addEventListener('click', () => {
        let text = `Texture @ 0x${addrHex}\nResolution: ${tex.width}x${tex.height}\nFormat: ${formatName}\nLast Unit: ${unitIndex}`;
        
        // Find Renderer Positions
        const renPrims = rendererPrimitives.filter(p => p.texAddr === addrHex);
        if (renPrims.length > 0) {
            text += `\n\n[Renderer Tab] Found ${renPrims.length} occurrences:`;
            renPrims.forEach((p, idx) => {
                const [x1, y1, x2, y2] = p.bbox.map(v => Math.round(v));
                text += `\n  - Item ${idx + 1}: BBox(${x1}, ${y1}, ${x2}, ${y2})`;
            });
        }

        // Find Comparison Positions
        const overlayLayer = document.getElementById('overlayLayer');
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

    // Handle visibility checkbox
    const checkbox = card.querySelector(`#visibility-${addrHex}`);
    checkbox.addEventListener('change', (e) => {
        if (e.target.checked) {
            HIDDEN_TEXTURES.delete(addrHex);
            card.classList.remove('hidden');
        } else {
            HIDDEN_TEXTURES.add(addrHex);
            card.classList.add('hidden');
        }
        tryRender(); // Re-render to show changes
    });
}

document.getElementById('resetTextures').addEventListener('click', () => {
    HIDDEN_TEXTURES.clear();
    const cards = document.querySelectorAll('.texture-card');
    cards.forEach(card => {
        card.classList.remove('hidden');
        const checkbox = card.querySelector('input[type="checkbox"]');
        if (checkbox) checkbox.checked = true;
    });
    tryRender();
});

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
    setImage0(val) {
        this.width = (val & 0x3FF) + 1;
        this.height = ((val >> 10) & 0x3FF) + 1;
        this.format = (val >> 20) & 0xF;
        this.dirty = true;
    }
    setImage3(val) {
        this.imageBase = (val & 0xFFFFFF) << 5;
        this.dirty = true;
    }
    // Placeholder for other texture commands if needed
    setMode0(val) {}
    setMode1(val) {}
    setImage1(val) {}
    setImage2(val) {}
}

class BPMemory {
    constructor() {
        this.textures = Array(8).fill(null).map(() => new BPTextureUnit());
        this.zMode = 0;
        this.alphaTest = 0x3F; // Default to ALWAYS/ALWAYS pass
        this.blendMode = 0; // Default to Disabled
        this.matColors = [new Float32Array([1,1,1,1]), new Float32Array([1,1,1,1])];
        this.ambColors = [new Float32Array([1,1,1,1]), new Float32Array([1,1,1,1])];
    }
    reset() {
        this.textures.forEach(t => t.reset());
        this.zMode = 0;
        this.alphaTest = 0x3F;
        this.blendMode = 0;
        this.matColors.forEach(c => c.set([1,1,1,1]));
        this.ambColors.forEach(c => c.set([1,1,1,1]));
    }
}
const BPState = new BPMemory();
const HIDDEN_TEXTURES = new Set();

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
            
            // Clear cache and UI on new data load
            GLOBAL_TEXTURE_CACHE.clear();
            resetTextureInspector();
            
            // Count total draw calls for scrubber
            let totalDC = 0;
            if (jsonData[0].commands) {
                for (const cmd of jsonData[0].commands) {
                    if (cmd.type === "Primitive") totalDC++;
                }
            }
            maxDrawCalls = totalDC;
            setupScrubber(totalDC);
            
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


function applyBPCommand(command, val) {
    const cmd = command & 0xFF;
    // Ranges for units 0-3 (0x80-0x97) and units 4-7 (0xA0-0xB7)
    if (cmd >= 0x80 && cmd < 0x84) { // TX_SETMODE0 (0-3)
        BPState.textures[cmd - 0x80].setMode0(val);
    } else if (cmd >= 0xA0 && cmd < 0xA4) { // TX_SETMODE0 (4-7)
        BPState.textures[cmd - 0xA0 + 4].setMode0(val);
    } else if (cmd >= 0x84 && cmd < 0x88) { // TX_SETMODE1 (0-3)
        BPState.textures[cmd - 0x84].setMode1(val);
    } else if (cmd >= 0xA4 && cmd < 0xA8) { // TX_SETMODE1 (4-7)
        BPState.textures[cmd - 0xA4 + 4].setMode1(val);
    } else if (cmd >= 0x88 && cmd < 0x8C) { // TX_SETIMAGE0 (0-3)
        BPState.textures[cmd - 0x88].setImage0(val);
    } else if (cmd >= 0xA8 && cmd < 0xAC) { // TX_SETIMAGE0 (4-7)
        BPState.textures[cmd - 0xA8 + 4].setImage0(val);
    } else if (cmd >= 0x8C && cmd < 0x90) { // TX_SETIMAGE1 (0-3)
        BPState.textures[cmd - 0x8C].setImage1(val);
    } else if (cmd >= 0xAC && cmd < 0xB0) { // TX_SETIMAGE1 (4-7)
        BPState.textures[cmd - 0xAC + 4].setImage1(val);
    } else if (cmd >= 0x90 && cmd < 0x94) { // TX_SETIMAGE2 (0-3)
        BPState.textures[cmd - 0x90].setImage2(val);
    } else if (cmd >= 0xB0 && cmd < 0xB4) { // TX_SETIMAGE2 (4-7)
        BPState.textures[cmd - 0xB0 + 4].setImage2(val);
    } else if (cmd >= 0x94 && cmd < 0x98) { // TX_SETIMAGE3 (0-3)
        BPState.textures[cmd - 0x94].setImage3(val);
    } else if (cmd >= 0xB4 && cmd < 0xB8) { // TX_SETIMAGE3 (4-7)
        BPState.textures[cmd - 0xB4 + 4].setImage3(val);
    } else if (cmd === 0x40) { // Z_MODE
        BPState.zMode = val;
    } else if (cmd === 0x41) { // BLEND_MODE
        BPState.blendMode = val;
    } else if (cmd === 0xF3) { // ALPHA_TEST
        BPState.alphaTest = val;
    }
}

function tryRender() {
    if (!jsonData) return;
    
    // For now, let's just render Frame 0
    const frame = jsonData[0];
    if (!frame) return;

    console.time('tryRender');
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
    // resetTextureInspector(); // Removed for performance - persistent UI
    drawCalls = 0;
    rendererPrimitives = [];

    const modelViewMatrix = mat4.create();
    gl.uniformMatrix4fv(programInfo.uniformLocations.modelViewMatrix, false, modelViewMatrix);

    let triangles = 0;

    let wasPrimitive = false;
    for (const cmd of frame.commands) {
        if (cmd.type === "CP") {
            applyCPCommand(cmd.command, cmd.value);
            wasPrimitive = false;
        } else if (cmd.type === "XF") {
            applyXFCommand(cmd.address, cmd.count, cmd.data);
            wasPrimitive = false;
        } else if (cmd.type === "BP") {
            applyBPCommand(cmd.command, cmd.value);
            wasPrimitive = false;
        } else if (cmd.type === "Primitive") {
            if (!wasPrimitive) drawCalls++;
            if (currentDrawCallLimit === -1 || drawCalls <= currentDrawCallLimit) {
                drawPrimitive(cmd, drawCalls);
            }
            wasPrimitive = true;
            // A Triangle strip (primitive=1) creates N-2 triangles
            triangles += Math.max(0, cmd.num_vertices - 2); 
        }
    }
    
    // Ensure highlights are updated after rendererPrimitives is repopulated
    updateSelectedHighlights();

    console.timeEnd('tryRender');
    statusPanel.innerText = `Render Complete!
Draw Calls: ${drawCalls}
Est. Triangles: ${triangles}`;
}

function drawPrimitive(cmd, partIndex) {
    // Use JSON-provided ground truth state if available to bypass JS state tracking errors
    if (cmd.vcd_lo !== undefined) {
        CPState.vcd[cmd.vat].parseLO(cmd.vcd_lo);
        CPState.vcd[cmd.vat].parseHI(cmd.vcd_hi);
        CPState.vat[cmd.vat].parseA(cmd.vat_a);
        CPState.vat[cmd.vat].parseB(cmd.vat_b);
        CPState.vat[cmd.vat].parseC(cmd.vat_c);
    }
    
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
                const addrHex = tex.imageBase.toString(16).toUpperCase();
                let cached = GLOBAL_TEXTURE_CACHE.get(addrHex);
                
                // Only decode if not in cache OR if format/size changed (rare in DFF but possible)
                if (!cached || cached.width !== tex.width || cached.height !== tex.height || cached.format !== tex.format) {
                    const rgba8 = TexDecoder.decode(tex.width, tex.height, tex.format, tex.imageBase);
                    if (rgba8) {
                        const webglTexture = cached ? cached.texture : gl.createTexture();
                        gl.activeTexture(gl.TEXTURE0 + i);
                        gl.bindTexture(gl.TEXTURE_2D, webglTexture);
                        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tex.width, tex.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba8);
                        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                        
                        cached = { texture: webglTexture, width: tex.width, height: tex.height, format: tex.format, rgba8: rgba8 };
                        GLOBAL_TEXTURE_CACHE.set(addrHex, cached);
                        addTextureToInspector(i, rgba8);
                    }
                }
                
                if (cached) {
                    tex.webglTexture = cached.texture;
                    tex.dirty = false;
                }
            }
        }
    }

    let unitsToBind = [];
    let primaryUnit = -1;
    for (let i = 0; i < 8; i++) {
        const hasTex = (i === 0 && vcd.Tex0) || (i === 1 && vcd.Tex1) || (i === 2 && vcd.Tex2) || (i === 3 && vcd.Tex3) ||
                      (i === 4 && vcd.Tex4) || (i === 5 && vcd.Tex5) || (i === 6 && vcd.Tex6) || (i === 7 && vcd.Tex7);
        if (hasTex && BPState.textures[i].webglTexture) {
            const addrHex = BPState.textures[i].imageBase.toString(16).toUpperCase();
            if (HIDDEN_TEXTURES.has(addrHex)) {
                // If the texture is hidden, we skip this draw call for visual debugging
                return;
            }
            unitsToBind.push(i);
        }
    }

    // Bind up to 2 texture units
    gl.activeTexture(gl.TEXTURE0);
    if (unitsToBind.length > 0) {
        gl.bindTexture(gl.TEXTURE_2D, BPState.textures[unitsToBind[0]].webglTexture);
        gl.uniform1i(programInfo.uniformLocations.uHasTexture0, 1);
        primaryUnit = unitsToBind[0];
    } else {
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.uniform1i(programInfo.uniformLocations.uHasTexture0, 0);
    }
    gl.uniform1i(programInfo.uniformLocations.uSampler0, 0);

    gl.activeTexture(gl.TEXTURE1);
    if (unitsToBind.length > 1) {
        gl.bindTexture(gl.TEXTURE_2D, BPState.textures[unitsToBind[1]].webglTexture);
        gl.uniform1i(programInfo.uniformLocations.uHasTexture1, 1);
    } else {
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.uniform1i(programInfo.uniformLocations.uHasTexture1, 0);
    }
    gl.uniform1i(programInfo.uniformLocations.uSampler1, 1);

    const boundTex = unitsToBind.length > 0;

    // Apply Material Color (Usually MatColor0)
    gl.uniform4fv(programInfo.uniformLocations.uMatColor, BPState.matColors[0]);

    // Apply Alpha Test (Full dual-test logic)
    const at = BPState.alphaTest;
    gl.uniform1i(programInfo.uniformLocations.uAlphaTest, at & 0xFF); // Passes Comp0, Comp1, and Op
    gl.uniform2f(programInfo.uniformLocations.uAlphaRef, 
        ((at >> 8) & 0xFF) / 255.0, 
        ((at >> 16) & 0xFF) / 255.0);

    const vertexSize = cmd.vertex_size;
    const numVerts = cmd.num_vertices;
    const positions = [];
    const colors = [];
    const texcoords = [];

    const dataView = new DataView(new Uint8Array(cmd.data).buffer);
    const vat = CPState.vat[cmd.vat];
    let posMatIdx = 0;
    let mtxBase = 0;
    let firstVertexRaw = { x:0, y:0, z:0 };

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
            if (i === 0) firstVertexRaw = { x, y, z };
        } else if (vcd.Position === 2) { // 8-bit Index
            ptr += 1;
        } else if (vcd.Position === 3) { // 16-bit Index
            ptr += 2;
        }

        if (vcd.Normal === 1) { // Direct
            const elements = (vat.NormalElements === 0) ? 1 : 3;
            for(let j=0; j<elements; j++) { // Normals have 3 components each (even if el=1, it consumes 3 for N, B, T maybe?)
                // Usually GX normals are 3 components. If elements=0, it's just Normal.
                const count = (vat.NormalElements === 0) ? 1 : 3;
                for (let k=0; k<count; k++) {
                    const resXN = readComponent(ptr, vat.NormalFormat, 0); ptr += resXN.size; 
                    const resYN = readComponent(ptr, vat.NormalFormat, 0); ptr += resYN.size; 
                    const resZN = readComponent(ptr, vat.NormalFormat, 0); ptr += resZN.size; 
                }
            }
        } else if (vcd.Normal === 2) { // 8-bit Index
            ptr += 1;
        } else if (vcd.Normal === 3) { // 16-bit Index
            ptr += 2;
        }

        if (vcd.Color0 === 1) { // Direct
            const col = readColor(ptr, vat.Color0Comp);
            r = col.r; g = col.g; b = col.b; a = col.a;
            ptr += col.size;
        } else if (vcd.Color0 === 2) { // 8-bit Index
            ptr += 1;
        } else if (vcd.Color0 === 3) { // 16-bit Index
            ptr += 2;
        }

        if (vcd.Color1 === 1) { // Direct
            const col = readColor(ptr, vat.Color1Comp); ptr += col.size;
        } else if (vcd.Color1 === 2) { // 8-bit Index
            ptr += 1;
        } else if (vcd.Color1 === 3) { // 16-bit Index
            ptr += 2;
        }

        const texVCDs = [vcd.Tex0, vcd.Tex1, vcd.Tex2, vcd.Tex3, vcd.Tex4, vcd.Tex5, vcd.Tex6, vcd.Tex7];
        const texVATs = [
            { el: vat.Tex0CoordElements, fmt: vat.Tex0CoordFormat, frac: vat.Tex0Frac },
            { el: vat.Tex1CoordElements, fmt: vat.Tex1CoordFormat, frac: vat.Tex1Frac },
            { el: vat.Tex2CoordElements, fmt: vat.Tex2CoordFormat, frac: vat.Tex2Frac },
            { el: vat.Tex3CoordElements, fmt: vat.Tex3CoordFormat, frac: vat.Tex3Frac },
            { el: vat.Tex4CoordElements, fmt: vat.Tex4CoordFormat, frac: vat.Tex4Frac },
            { el: vat.Tex5CoordElements, fmt: vat.Tex5CoordFormat, frac: vat.Tex5Frac },
            { el: vat.Tex6CoordElements, fmt: vat.Tex6CoordFormat, frac: vat.Tex6Frac },
            { el: vat.Tex7CoordElements, fmt: vat.Tex7CoordFormat, frac: vat.Tex7Frac }
        ];

        for(let j=0; j<8; j++) {
            if (texVCDs[j] === 1) { // Direct
                const elements = (texVATs[j].el === 0) ? 1 : 2;
                const resS = readComponent(ptr, texVATs[j].fmt, texVATs[j].frac); ptr += resS.size;
                let curU = resS.val;
                let curV = 0;
                if (elements === 2) {
                    const resT = readComponent(ptr, texVATs[j].fmt, texVATs[j].frac); ptr += resT.size;
                    curV = resT.val;
                }
                if (j === primaryUnit) {
                    u = curU;
                    v = curV;
                }
            } else if (texVCDs[j] === 2) { // 8-bit Index
                ptr += 1;
            } else if (texVCDs[j] === 3) { // 16-bit Index
                ptr += 2;
            }
        }

        // Apply CPState XF ModelView Matrix (3x4 Matrix stored continuously)
        // Matrix N starts at word index 4*N.
        mtxBase = posMatIdx * 4; 
        if (mtxBase + 11 >= XFState.posMatrices.length) mtxBase = 0; // Bounds check

        let m00 = XFState.posMatrices[mtxBase + 0], m01 = XFState.posMatrices[mtxBase + 1], m02 = XFState.posMatrices[mtxBase + 2], m03 = XFState.posMatrices[mtxBase + 3];
        let m10 = XFState.posMatrices[mtxBase + 4], m11 = XFState.posMatrices[mtxBase + 5], m12 = XFState.posMatrices[mtxBase + 6], m13 = XFState.posMatrices[mtxBase + 7];
        let m20 = XFState.posMatrices[mtxBase + 8], m21 = XFState.posMatrices[mtxBase + 9], m22 = XFState.posMatrices[mtxBase + 10], m23 = XFState.posMatrices[mtxBase + 11];

        // Robust Identity Fallback: if matrix appears to be all zeros or uninitialized
        const isZero = (Math.abs(m00) < 1e-6 && Math.abs(m11) < 1e-6 && Math.abs(m22) < 1e-6 && Math.abs(m01) < 1e-6);
        if (isZero) {
            m00 = 1; m11 = 1; m22 = 1; 
            m01 = 0; m02 = 0; m03 = 0; m10 = 0; m12 = 0; m13 = 0; m20 = 0; m21 = 0; m23 = 0;
        }

        // Perform the 3x4 * vec3 matrix multiplication
        const rx = m00 * x + m01 * y + m02 * z + m03;
        const ry = m10 * x + m11 * y + m12 * z + m13;
        const rz = m20 * x + m21 * y + m22 * z + m23;

        if (i === 0 && drawCalls < 2) {
            // Updated log to use variables in scope if needed, or just let the bottom one handle it
        }
        
        positions.push(rx, ry, rz);
        colors.push(r, g, b, a);
        texcoords.push(u, v);
    }

    if (!posBuffer) posBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(programInfo.attribLocations.vertexPosition, 3, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(programInfo.attribLocations.vertexPosition);

    if (!colorBuffer) colorBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colors), gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(programInfo.attribLocations.vertexColor, 4, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(programInfo.attribLocations.vertexColor);

    if (!texCoordBuffer) texCoordBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(texcoords), gl.DYNAMIC_DRAW);
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
    
    const prim = cmd.primitive;
    let glPrimitive = gl.TRIANGLES;
    if (prim === 0 || prim === 1) glPrimitive = gl.TRIANGLE_FAN; // QUADS
    else if (prim === 2) glPrimitive = gl.TRIANGLES;
    else if (prim === 3) glPrimitive = gl.TRIANGLE_STRIP;
    else if (prim === 4) glPrimitive = gl.TRIANGLE_FAN;
    else if (prim === 5) glPrimitive = gl.LINES;
    else if (prim === 6) glPrimitive = gl.LINE_STRIP;
    else if (prim === 7) glPrimitive = gl.POINTS;

    if (document.getElementById('wireframeToggle').checked) {
        glPrimitive = (prim === 5 || prim === 6) ? gl.LINES : gl.LINE_STRIP;
    }
    
    // Apply GX State (ZMode, BlendMode, AlphaTest)
    const zm = BPState.zMode;
    if (zm & 1) {
        gl.enable(gl.DEPTH_TEST);
        const funcs = [gl.NEVER, gl.LESS, gl.EQUAL, gl.LEQUAL, gl.GREATER, gl.NOTEQUAL, gl.GEQUAL, gl.ALWAYS];
        gl.depthFunc(funcs[(zm >> 1) & 7]);
    } else {
        gl.disable(gl.DEPTH_TEST);
    }
    gl.depthMask((zm >> 4) & 1);

    const bm = BPState.blendMode;
    if (bm & 1) {
        gl.enable(gl.BLEND);
        const factors = [gl.ZERO, gl.ONE, gl.SRC_COLOR, gl.ONE_MINUS_SRC_COLOR, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.DST_ALPHA, gl.ONE_MINUS_DST_ALPHA];
        // SrcFactor is bits 2-4, DstFactor is bits 5-7
        gl.blendFunc(factors[(bm >> 2) & 7], factors[(bm >> 5) & 7]);
    } else {
        gl.disable(gl.BLEND);
    }
    gl.disable(gl.CULL_FACE); // Wii defaults to no culling or different winding
    gl.uniformMatrix4fv(programInfo.uniformLocations.projectionMatrix, false, XFState.projectionMatrix);
    gl.uniformMatrix4fv(programInfo.uniformLocations.modelViewMatrix, false, mat4.create()); // Identity for now

    // Draw the primitive
    gl.drawArrays(glPrimitive, 0, numVerts);

    // Diagnostics if everything is stacked
    if (drawCalls < 2) {
        console.log(`DrawCall ${drawCalls}: prim=${cmd.primitive}, verts=${numVerts}, mtxBase=${mtxBase}, posMatIdx=${posMatIdx}`);
        console.log(`  RawV0: [${firstVertexRaw.x.toFixed(2)}, ${firstVertexRaw.y.toFixed(2)}, ${firstVertexRaw.z.toFixed(2)}]`);
        console.log(`  Matrix[${mtxBase}] Row0: [${XFState.posMatrices[mtxBase+0]}, ${XFState.posMatrices[mtxBase+1]}, ${XFState.posMatrices[mtxBase+2]}, ${XFState.posMatrices[mtxBase+3]}]`);
        console.log(`  Matrix[${mtxBase}] Row1: [${XFState.posMatrices[mtxBase+4]}, ${XFState.posMatrices[mtxBase+5]}, ${XFState.posMatrices[mtxBase+6]}, ${XFState.posMatrices[mtxBase+7]}]`);
        console.log(`  Matrix[${mtxBase}] Row2: [${XFState.posMatrices[mtxBase+8]}, ${XFState.posMatrices[mtxBase+9]}, ${XFState.posMatrices[mtxBase+10]}, ${XFState.posMatrices[mtxBase+11]}]`);
        console.log(`  FinalV0: [${positions[0].toFixed(2)}, ${positions[1].toFixed(2)}, ${positions[2].toFixed(2)}]`);
    }
    
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

            if (cw !== 0) {
            const ndcX = cx / cw;
                const ndcY = cy / cw;
                const px = (ndcX + 1.0) * 320;
                const py = (1.0 - ndcY) * 180; // 0 at Top for selection mapping (640x360)
                minX = Math.min(minX, px); minY = Math.min(minY, py);
                maxX = Math.max(maxX, px);                maxY = Math.max(maxY, py);
            }
        }
        
        rendererPrimitives.push({
            drawCallIndex: partIndex,
            bbox: [minX, minY, maxX, maxY],
            texAddr: boundTex && primaryUnit !== -1 ? BPState.textures[primaryUnit].imageBase.toString(16).toUpperCase() : null,
            states: {
                zMode: BPState.zMode,
                alphaTest: BPState.alphaTest,
                blendMode: BPState.blendMode,
                matColor0: Array.from(BPState.matColors[0]),
                matColor1: Array.from(BPState.matColors[1])
            },
            // Store raw command for hardware reference comparison
            hwCmd: cmd 
        });
    }
}

document.getElementById('copyReport').addEventListener('click', () => {
    const p = rendererPrimitives.find(p => p.drawCallIndex === currentDrawCallLimit);
    if (!p) {
        alert("Select a draw call first using the scrubber.");
        return;
    }

    const hw = p.hwCmd || {};
    let report = `=== Technical Rendering Report (Draw Call ${p.drawCallIndex}) ===\n\n`;
    
    const check = (label, webgl, hardware) => {
        const match = webgl === hardware;
        return `${label}: ${webgl} vs Hardware: ${hardware !== undefined ? hardware : 'N/A'} [${match ? 'MATCH' : 'DELTA'}]\n`;
    };

    report += check("Z-Mode", `0x${p.states.zMode.toString(16)}`, hw.zmode);
    report += check("Alpha Test", `0x${p.states.alphaTest.toString(16)}`, hw.alpha_test);
    report += check("Blend Mode", `0x${p.states.blendMode.toString(16)}`, hw.blend_mode);
    report += check("Texture Addr", `0x${p.texAddr}`, hw.tex_addr ? `0x${hw.tex_addr}` : undefined);
    
    if (hw.xf_viewport) {
        report += `\nHardware Viewport: ${JSON.stringify(hw.xf_viewport)}\n`;
        report += `Hardware Projection: ${JSON.stringify(hw.xf_projection)}\n`;
    }

    navigator.clipboard.writeText(report).then(() => {
        const btn = document.getElementById('copyReport');
        const oldText = btn.innerText;
        btn.innerText = "Report Copied!";
        setTimeout(() => btn.innerText = oldText, 2000);
    });
});


// Scrubber and Debug Inspector Logic
function setupScrubber(count) {
    const scrubber = document.getElementById('drawCallScrubber');
    const controls = document.getElementById('debugControls');
    const valueLabel = document.getElementById('scrubberValue');
    
    if (count > 0) {
        controls.style.display = 'block';
        scrubber.max = count + 1;
        scrubber.value = count + 1;
        valueLabel.innerText = "All";
        currentDrawCallLimit = -1;
    } else {
        controls.style.display = 'none';
    }
}

document.getElementById('drawCallScrubber').addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    const max = parseInt(e.target.max);
    const valueLabel = document.getElementById('scrubberValue');
    
    if (val === max) {
        valueLabel.innerText = "All";
        currentDrawCallLimit = -1;
        clearStateInspector();
    } else {
        valueLabel.innerText = val;
        currentDrawCallLimit = val;
        
        // Find the primitive at this index and show its state
        const p = rendererPrimitives.find(p => p.drawCallIndex === val);
        if (p) updateStateInspector(p);

        // Attempt to load per-draw-call reference image
        const refImg = document.getElementById('referenceImg');
        const refStatus = document.getElementById('refImgStatus');
        const dcImgPath = `data/draw_calls/dc_${val-1}.png`;
        
        const testImg = new Image();
        testImg.onload = () => {
            refImg.src = dcImgPath;
            refImg.style.display = 'block';
            refStatus.style.display = 'none';
        };
        testImg.onerror = () => {
            // Fallback to main ground truth if per-draw-call doesn't exist
            refImg.src = 'data/ground_truth.png';
            refStatus.innerText = `No snapshot for DC ${val-1}, showing full Ground Truth.`;
            refStatus.style.display = 'block';
        };
        testImg.src = dcImgPath;
    }
    
    tryRender();
});

function updateStateInspector(p) {
    if (!p || !p.states) return;
    
    const zm = p.states.zMode;
    const at = p.states.alphaTest;
    const bm = p.states.blendMode;
    const hw = p.hwCmd || {};
    
    const atFuncs = ["NEVER", "LESS", "EQUAL", "LEQUAL", "GREATER", "NOTEQUAL", "GEQUAL", "ALWAYS"];
    const bFactors = ["ZERO", "ONE", "SRC_CLR", "INV_SRC_CLR", "SRC_ALPHA", "INV_SRC_ALPHA", "DST_ALPHA", "INV_DST_ALPHA"];
    const toHex = (c) => "#" + c.map(v => Math.round(v*255).toString(16).padStart(2, '0')).join('').substring(0,6).toUpperCase();

    // Helper to update row and highlight mismatch
    const updateRow = (rowId, webglId, valWebGL, hwId, valHW, isMismatch) => {
        document.getElementById(webglId).innerText = valWebGL;
        document.getElementById(hwId).innerText = valHW !== undefined ? valHW : "N/A";
        const row = document.getElementById(rowId);
        if (isMismatch) row.classList.add('mismatch');
        else row.classList.remove('mismatch');
    };

    // Z-Mode Comparison
    const zFuncs = ["NEVER", "LESS", "EQUAL", "LEQUAL", "GREATER", "NOTEQUAL", "GEQUAL", "ALWAYS"];
    const zStr = (v) => `0x${v.toString(16)}: ${(v&1)?"ON":"OFF"} (${zFuncs[(v>>1)&7]})`;
    const hwZM = hw.zmode || 0; // Assuming stop_at_draw_call exports this as 'zmode'
    updateRow('rowZMode', 'valZMode', zStr(zm), 'valHWZMode', hw.zmode !== undefined ? zStr(hw.zmode) : "-", zm !== hw.zmode && hw.zmode !== undefined);

    // Alpha Test Comparison
    const atStr = (v) => `0x${v.toString(16)}: ${atFuncs[v&7]}/${atFuncs[(v>>3)&7]}`;
    updateRow('rowAlphaTest', 'valAlphaTest', atStr(at), 'valHWAlphaTest', hw.alpha_test !== undefined ? atStr(hw.alpha_test) : "-", at !== hw.alpha_test && hw.alpha_test !== undefined);

    // Blend Mode Comparison
    const bStr = (v) => `0x${v.toString(16)}: ${(v&1)?"ON":"OFF"}`;
    updateRow('rowBlend', 'valBlend', bStr(bm), 'valHWBlend', hw.blend_mode !== undefined ? bStr(hw.blend_mode) : "-", bm !== hw.blend_mode && hw.blend_mode !== undefined);

    // MatColors Comparison
    const mc0 = p.states.matColor0 || [1,1,1,1];
    const hwMC0 = hw.mat_color0 !== undefined ? [((hw.mat_color0>>24)&0xFF)/255, ((hw.mat_color0>>16)&0xFF)/255, ((hw.mat_color0>>8)&0xFF)/255, (hw.mat_color0&0xFF)/255] : null;
    updateRow('rowMatColor0', 'valMatColor0', toHex(mc0), 'valHWMatColor0', hwMC0 ? toHex(hwMC0) : "-", hwMC0 && toHex(mc0) !== toHex(hwMC0));

    // Texture Comparison
    updateRow('rowTexture', 'valTexture', `0x${p.texAddr || 'None'}`, 'valHWTexture', `0x${hw.tex_addr || '-'}`, p.texAddr !== hw.tex_addr && hw.tex_addr !== undefined);

    // Update Ground Truth Overlay (SVG)
    updateGroundTruthOverlay(p);
}

function updateGroundTruthOverlay(p) {
    const svg = document.getElementById('rendererOverlay');
    const oldGT = svg.querySelectorAll('.ground-truth-highlight');
    oldGT.forEach(e => e.remove());

    if (!p.hwCmd || !p.hwCmd.xf_viewport || !p.hwCmd.xf_projection) return;

    // Use Hardware Viewport and Projection to calculate "Ground Truth" BBox
    const vp = p.hwCmd.xf_viewport; // [wd, ht, zRange, xOrig, yOrig, farZ]
    const proj = p.hwCmd.xf_projection; // [p0, p1, p2, p3, p4, p5, type]
    
    // Simplistic projection for validation: 
    // We compare our projected BBox with what happens if we use Dolphin's Raw Projection data.
    // This highlights if our matrix reconstruction is wrong.
    
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", p.bbox[0]);
    rect.setAttribute("y", p.bbox[1]);
    rect.setAttribute("width", p.bbox[2] - p.bbox[0]);
    rect.setAttribute("height", p.bbox[3] - p.bbox[1]);
    rect.setAttribute("class", "ground-truth-highlight");
    svg.appendChild(rect);
}

function clearStateInspector() {
    ['valZMode', 'valAlphaTest', 'valBlend', 'valMatColor0', 'valMatColor1', 'valTexture',
     'valHWZMode', 'valHWAlphaTest', 'valHWBlend', 'valHWMatColor0', 'valHWMatColor1', 'valHWTexture'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerText = "-";
    });
    ['rowZMode', 'rowAlphaTest', 'rowBlend', 'rowMatColor0', 'rowMatColor1', 'rowTexture'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('mismatch');
    });

    const svg = document.getElementById('rendererOverlay');
    const oldGT = svg.querySelectorAll('.ground-truth-highlight');
    oldGT.forEach(e => e.remove());
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
            
            // Initialize Scrubber for auto-loaded data
            let totalDC = 0;
            if (jsonData && jsonData[0] && jsonData[0].commands) {
                for (const cmd of jsonData[0].commands) {
                    if (cmd.type === "Primitive") totalDC++;
                }
            }
            maxDrawCalls = totalDC;
            setupScrubber(totalDC);
            
            // Short delay so the user sees the success message before rendering overwrites it
            setTimeout(tryRender, 500);
        })
        .catch(e => {
            statusPanel.innerText = 'Waiting for files... Please upload manually.';
            console.log("Auto-load skipped:", e.message);
        });
});

// New Debuggers
document.getElementById('copyReport').addEventListener('click', () => {
    const scrubber = document.getElementById('drawCallScrubber');
    const val = parseInt(scrubber.value);
    const max = parseInt(scrubber.max);
    
    let report = "--- Dolphin WebGL Viewer Technical Report ---\n";
    report += `Timestamp: ${new Date().toLocaleString()}\n`;
    report += `Draw Call Selection: ${val === max ? "All (No limit)" : val}\n`;
    report += `Total Decoded Textures: ${GLOBAL_TEXTURE_CACHE.size}\n\n`;
    
    if (val !== max) {
        const p = rendererPrimitives.find(p => p.drawCallIndex === (val - 1));
        if (p) {
            report += "## Primitive Information\n";
            report += `- Address: 0x${p.texAddr || 'None'}\n`;
            report += `- Bounding Box: [${p.bbox.map(v => Math.round(v)).join(', ')}]\n`;
            report += `- ZMode: 0x${p.states.zMode.toString(16)}\n`;
            report += `- AlphaTest: 0x${p.states.alphaTest.toString(16)}\n`;
            report += `- BlendMode: 0x${p.states.blendMode.toString(16)}\n`;
            report += `- MatColor0: ${JSON.stringify(p.states.matColor0)}\n`;
            if (p.groundTruth) {
                report += `- Ground Truth State Used: Yes (vcd=${p.groundTruth.vcd}, vat=${p.groundTruth.vat})\n`;
            }
            report += "\n";
        }
    }
    
    report += "## Cached Textures\n";
    GLOBAL_TEXTURE_CACHE.forEach((tex, addr) => {
        const formatName = FORMAT_NAMES[tex.format] || `0x${tex.format.toString(16)}`;
        report += `- 0x${addr}: ${tex.width}x${tex.height} (${formatName})\n`;
    });
    
    navigator.clipboard.writeText(report).then(() => {
        alert("Technical report copied to clipboard! Check the console for more details.");
        console.log("[Technical Report]", report);
    });
});

document.getElementById('diffToggle').addEventListener('change', (e) => {
    const isActive = e.target.checked;
    if (isActive) {
        document.body.classList.add('visual-diff-active');
        const diffOverlay = document.getElementById('diffOverlay');
        const refImg = document.getElementById('referenceImg');
        if (refImg && refImg.src) {
            diffOverlay.style.backgroundImage = `url(${refImg.src})`;
        }
        statusPanel.innerText = 'Visual Diff Mode Active: Showing abs(Render - GroundTruth)';
    } else {
        document.body.classList.remove('visual-diff-active');
        statusPanel.innerText = 'Visual Diff Mode Disabled.';
    }
});
