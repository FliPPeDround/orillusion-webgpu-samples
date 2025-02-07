import basicVert from './shaders/basic.vert.wgsl?raw'
import sampleTexture from './shaders/sampleTexture.frag.wgsl?raw'
import * as cube from './util/cube'
import { getMvpMatrix } from './util/math'

// initialize webgpu device & config canvas context
async function initWebGPU(canvas: HTMLCanvasElement) {
    if (!navigator.gpu)
        throw new Error('Not Support WebGPU')
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter)
        throw new Error('No Adapter Found')
    const device = await adapter.requestDevice()
    const context = canvas.getContext('webgpu') as GPUCanvasContext
    const format = context.getPreferredFormat(adapter)
    const devicePixelRatio = window.devicePixelRatio || 1
    const size = {
        width: canvas.clientWidth * devicePixelRatio,
        height: canvas.clientHeight * devicePixelRatio,
    }
    context.configure({
        device, format, size,
        // prevent chrome warning after v102
        compositingAlphaMode: 'opaque'
    })
    return { device, context, format, size }
}

// create pipiline & buffers
async function initPipeline(device: GPUDevice, format: GPUTextureFormat, size: { width: number, height: number }, size2:number[]) {
    const pipeline = await device.createRenderPipelineAsync({
        label: 'Basic Pipline',
        vertex: {
            module: device.createShaderModule({
                code: basicVert,
            }),
            entryPoint: 'main',
            buffers: [{
                arrayStride: 5 * 4, // 3 position 2 uv,
                attributes: [
                    {
                        // position
                        shaderLocation: 0,
                        offset: 0,
                        format: 'float32x3',
                    },
                    {
                        // uv
                        shaderLocation: 1,
                        offset: 3 * 4,
                        format: 'float32x2',
                    }
                ]
            }]
        },
        fragment: {
            module: device.createShaderModule({
                code: sampleTexture,
            }),
            entryPoint: 'main',
            targets: [
                {
                    format: format
                }
            ]
        },
        primitive: {
            topology: 'triangle-list',
            // Culling backfaces pointing away from the camera
            cullMode: 'back',
            frontFace: 'ccw'
        },
        // Enable depth testing since we have z-level positions
        // Fragment closest to the camera is rendered in front
        depthStencil: {
            depthWriteEnabled: true,
            depthCompare: 'less',
            format: 'depth24plus',
        }
    } as GPURenderPipelineDescriptor)
    // create depthTexture for renderPass
    const depthTexture = device.createTexture({
        size, format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    // create vertex buffer
    const vertexBuffer = device.createBuffer({
        label: 'GPUBuffer store vertex',
        size: cube.vertex.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(vertexBuffer, 0, cube.vertex)
    // create a mvp matrix buffer
    const mvpBuffer = device.createBuffer({
        label: 'GPUBuffer store 4x4 matrix',
        size: 4 * 4 * 4, // 4 x 4 x float32
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    // create empty texture
    const cubeTexture = device.createTexture({
        size: size2,
        format: 'rgba8unorm',
        usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.RENDER_ATTACHMENT,
    })
   
    // Create a sampler with linear filtering for smooth interpolation.
    const sampler = device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
    })
    // create a uniform group contains matrix, texture & sampler
    const uniformGroup = device.createBindGroup({
        label: 'Uniform Group with Matrix/Texture/Sampler',
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: mvpBuffer
                }
            },
            {
                binding: 1,
                resource: sampler
            },
            {
                binding: 2,
                resource: cubeTexture.createView()
            }
        ]
    })
    // return all vars
    return { pipeline, vertexBuffer, mvpBuffer, uniformGroup, depthTexture, cubeTexture }
}

// create & submit device commands
function draw(
    device: GPUDevice,
    context: GPUCanvasContext,
    pipelineObj: {
        pipeline: GPURenderPipeline
        vertexBuffer: GPUBuffer
        mvpBuffer: GPUBuffer
        uniformGroup: GPUBindGroup
        depthTexture: GPUTexture
    }
) {
    // start encoder
    const commandEncoder = device.createCommandEncoder()
    const renderPassDescriptor: GPURenderPassDescriptor = {
        colorAttachments: [
            {
                view: context.getCurrentTexture().createView(),
                clearValue: { r: 0, g: 0, b: 0, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store'
            }
        ],
        depthStencilAttachment: {
            view: pipelineObj.depthTexture.createView(),
            depthClearValue: 1.0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
        }
    }
    const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor)
    passEncoder.setPipeline(pipelineObj.pipeline)
    // set uniformGroup
    passEncoder.setBindGroup(0, pipelineObj.uniformGroup)
    // set vertex
    passEncoder.setVertexBuffer(0, pipelineObj.vertexBuffer)
    // draw vertex count of cube
    passEncoder.draw(cube.vertexCount)
    passEncoder.end()
    // webgpu run in a separate process, all the commands will be executed after submit
    device.queue.submit([commandEncoder.finish()])
}

async function run() {
    const canvas = document.querySelector('canvas#webgpu') as HTMLCanvasElement
    const canvas2 = document.querySelector('canvas#canvas') as HTMLCanvasElement
    if (!canvas || !canvas2)
        throw new Error('No Canvas')
    const size2 = [canvas2.width, canvas2.height]
    const { device, context, format, size } = await initWebGPU(canvas)
    const pipelineObj = await initPipeline(device, format, size, size2)
    // default state
    let aspect = size.width / size.height
    const position = { x: 0, y: 0, z: -5 }
    const scale = { x: 1, y: 1, z: 1 }
    const rotation = { x: 0, y: 0, z: 0 }
    // start loop
    function frame() {
        // rotate by time, and update transform matrix
        const now = Date.now() / 1000
        rotation.x = Math.sin(now)
        rotation.y = Math.cos(now)
        const mvpMatrix = getMvpMatrix(aspect, position, rotation, scale)
        device.queue.writeBuffer(
            pipelineObj.mvpBuffer,
            0,
            mvpMatrix.buffer
        )
        // update texture from canvas every frame
        device.queue.copyExternalImageToTexture(
            { source: canvas2 },
            { texture: pipelineObj.cubeTexture },
            size2
        )
        // then draw
        draw(device, context, pipelineObj)
        requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)

    // re-configure context on resize
    window.addEventListener('resize', () => {
        size.width = canvas.clientWidth * devicePixelRatio
        size.height = canvas.clientHeight * devicePixelRatio
        // reconfigure canvas
        context.configure({
            device, format, size,
            compositingAlphaMode: 'opaque'
        })
        // re-create depth texture
        pipelineObj.depthTexture.destroy()
        pipelineObj.depthTexture = device.createTexture({
            size, format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        })
        // update aspect
        aspect = size.width / size.height
    })

    // a simple 2d canvas whiteboard
    {
        const ctx = canvas2.getContext('2d')
        if(!ctx)
            throw new Error('No support 2d')
        ctx.fillStyle = '#fff'
        ctx.lineWidth = 5
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.fillRect(0,0, canvas2.width, canvas2.height)

        let drawing = false
        let lastX = 0, lastY = 0
        let hue = 0
        canvas2.addEventListener('pointerdown', (e:PointerEvent) => {
            drawing = true
            lastX = e.offsetX
            lastY = e.offsetY
        })
        canvas2.addEventListener('pointermove', (e:PointerEvent) => {
            if(!drawing)
                return
            const x = e.offsetX
            const y = e.offsetY
            hue = hue > 360 ? 0 : hue +1
            ctx.strokeStyle = `hsl(${ hue }, 90%, 50%)`
            ctx.beginPath()
            ctx.moveTo(lastX, lastY)
            ctx.lineTo(x, y)
            ctx.stroke()

            lastX = x
            lastY = y
        })
        canvas2.addEventListener('pointerup', ()=> drawing = false)
        canvas2.addEventListener('pointerout', ()=> drawing = false)
    }
}
run()