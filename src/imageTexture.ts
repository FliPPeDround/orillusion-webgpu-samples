import basicVert from './shaders/basic.vert.wgsl?raw'
import sampleTexture from './shaders/sampleTexture.frag.wgsl?raw'
import * as cube from './util/cube'
import { getMvpMatrix } from './util/math'
import textureUrl from '/texture.webp?url'

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
async function initPipeline(device: GPUDevice, format: GPUTextureFormat, size: { width: number, height: number }) {
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
    // fetch image and upload to a GPUTexture
    const res = await fetch(textureUrl)
    const img = await res.blob()
    // const img = document.createElement('img')
    // img.src = textureUrl
    // await img.decode()
    const bitmap = await createImageBitmap(img)
    const cubeTexture = device.createTexture({
        size: [bitmap.width, bitmap.height, 1],
        format: 'rgba8unorm',
        usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.RENDER_ATTACHMENT,
    })
    device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture: cubeTexture },
        [bitmap.width, bitmap.height]
    )
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
    return { pipeline, vertexBuffer, mvpBuffer, uniformGroup, depthTexture }
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
    const canvas = document.querySelector('canvas')
    if (!canvas)
        throw new Error('No Canvas')
    const { device, context, format, size } = await initWebGPU(canvas)
    const pipelineObj = await initPipeline(device, format, size)
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
        // then draw
        draw(device, context, pipelineObj)
        requestAnimationFrame(frame)
    }
    frame()

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
}
run()