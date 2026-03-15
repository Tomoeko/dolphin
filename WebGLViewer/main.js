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
let isWireframe = false;

// Basic Shaders
const vertexShaderSource = `
    attribute vec4 aVertexPosition;
    attribute vec4 aVertexColor;
    varying lowp vec4 vColor;
    
    uniform mat4 uModelViewMatrix;
    uniform mat4 uProjectionMatrix;

    void main() {
        gl_Position = uProjectionMatrix * uModelViewMatrix * aVertexPosition;
        // Defaulting z to some depth since GX doesn't always provide it in 2D frames
        if (gl_Position.w == 0.0) gl_Position.w = 1.0;
        
        vColor = aVertexColor;
    }
`;

const fragmentShaderSource = `
    varying lowp vec4 vColor;
    void main() {
        gl_FragColor = vColor;
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
    },
    uniformLocations: {
        projectionMatrix: gl.getUniformLocation(shaderProgram, 'uProjectionMatrix'),
        modelViewMatrix: gl.getUniformLocation(shaderProgram, 'uModelViewMatrix'),
    },
};

// Application State
const CPState = {
    vat: new Array(8).fill(null).map(() => ({ posElements: 0, colorElements: 0, texElements: 0 }))
};

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

function applyCPCommand(cmd, value) {
    // Basic CPState tracking (VCD_LO, VCD_HI, VAT_A, VAT_B, VAT_C)
    // This is extremely simplified and meant as a placeholder for full attribute decoding.
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

    // Setup an orthographic projection (Wii home menu is often rendered in 2D ortho)
    const projectionMatrix = mat4.create();
    mat4.ortho(projectionMatrix, 0, 640, 528, 0, -1000, 1000);
    
    const modelViewMatrix = mat4.create();

    gl.uniformMatrix4fv(programInfo.uniformLocations.projectionMatrix, false, projectionMatrix);
    gl.uniformMatrix4fv(programInfo.uniformLocations.modelViewMatrix, false, modelViewMatrix);

    let drawCalls = 0;
    let triangles = 0;

    for (const cmd of frame.commands) {
        if (cmd.type === "CP") {
            applyCPCommand(cmd.command, cmd.value);
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

    const vertexSize = cmd.vertex_size;
    const numVerts = cmd.num_vertices;
    const positions = [];
    const colors = [];

    const dataView = new DataView(new Uint8Array(cmd.data).buffer);

    for (let i = 0; i < numVerts; i++) {
        const offset = i * vertexSize;
        
        // This is a HUGE simplification. A true GX emulator reads the VAT
        // to determine if position is 2xF32, 3xF32, 2xS16, 3xS16 etc.
        // For the Home Menu 2D ortho primitives, we often see 3xF32 or 2xF32.
        
        let x = 0, y = 0, z = 0;
        
        // Very hacky check: if the first 4 bytes look like a float in range
        try {
            x = dataView.getFloat32(offset + 0, false); // GX is big endian
            y = dataView.getFloat32(offset + 4, false);
            // Default to some valid range if NaN or unbounded
            if (isNaN(x) || Math.abs(x) > 4000) {
               // Fallback to S16
               x = dataView.getInt16(offset + 0, false);
               y = dataView.getInt16(offset + 2, false);
            }
        } catch(e) {}
        
        positions.push(x, y, z);
        
        // Random colors per vertex for debug
        colors.push(
            Math.random() * 0.5 + 0.5, 
            Math.random() * 0.5 + 0.5, 
            Math.random() * 0.5 + 0.5, 
            1.0
        );
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
