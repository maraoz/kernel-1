import { DEBUG, EDITOR, ENGINE_DEBUG_PANEL, SCENE_DEBUG_PANEL, SHOW_FPS_COUNTER } from 'config'
import './UnityInterface'
import { teleportTriggered } from 'shared/loading/types'
import { ILand, SceneJsonData } from 'shared/types'
import { enableParcelSceneLoading, loadParcelScene } from 'shared/world/parcelSceneManager'
import { teleportObservable } from 'shared/world/positionThings'
import {
  observeLoadingStateChange,
  observeRendererStateChange,
  observeSessionStateChange,
  renderStateObservable
} from 'shared/world/worldState'
import { ILandToLoadableParcelScene } from 'shared/selectors'
import { UnityParcelScene } from './UnityParcelScene'
import { getUnityInstance } from './IUnityInterface'
import { clientDebug, ClientDebug } from './ClientDebug'
import { getParcelSceneID, UnityScene } from './UnityScene'
import { ensureUiApis } from 'shared/world/uiSceneInitializer'
import { kernelConfigForRenderer } from './kernelConfigForRenderer'
import { store } from 'shared/store/isolatedStore'
import { isLoadingScreenVisible } from 'shared/loading/selectors'
import type { UnityGame } from '@dcl/unity-renderer/src'
import { reloadScene } from 'decentraland-loader/lifecycle/utils/reloadScene'
import { fetchSceneIds } from 'decentraland-loader/lifecycle/utils/fetchSceneIds'
import { signalParcelLoadingStarted } from 'shared/renderer/actions'
import { traceDecoratorUnityGame } from './trace'
import defaultLogger from 'shared/logger'

const hudWorkerRaw = require('raw-loader!../../static/systems/decentraland-ui.scene.js')
const hudWorkerBLOB = new Blob([hudWorkerRaw])
export const hudWorkerUrl = URL.createObjectURL(hudWorkerBLOB)

declare const globalThis: { clientDebug: ClientDebug }

globalThis.clientDebug = clientDebug

export function setLoadingScreenBasedOnState() {
  let state = store.getState()

  if (!state) {
    getUnityInstance().SetLoadingScreen({
      isVisible: true,
      message: 'Loading...',
      showTips: true
    })
    return
  }

  let loading = state.loading

  getUnityInstance().SetLoadingScreen({
    isVisible: isLoadingScreenVisible(state),
    message: loading.message || loading.status || '',
    showTips: loading.initialLoad || !state.renderer.parcelLoadingStarted
  })
}

////////////////////////////////////////////////////////////////////////////////

/**
 *
 * Common initialization logic for the unity engine
 *
 * @param _gameInstance Unity game instance
 */
export async function initializeEngine(_gameInstance: UnityGame): Promise<void> {
  const gameInstance = traceDecoratorUnityGame(_gameInstance)

  getUnityInstance().Init(gameInstance)

  getUnityInstance().DeactivateRendering()

  getUnityInstance().SetKernelConfiguration(kernelConfigForRenderer())

  if (DEBUG) {
    getUnityInstance().SetDebug()
  }

  if (SCENE_DEBUG_PANEL) {
    getUnityInstance().SetKernelConfiguration({ debugConfig: { sceneDebugPanelEnabled: true } })
    getUnityInstance().SetSceneDebugPanel()
  }

  if (SHOW_FPS_COUNTER) {
    getUnityInstance().ShowFPSPanel()
  }

  if (ENGINE_DEBUG_PANEL) {
    getUnityInstance().SetEngineDebugPanel()
  }

  observeLoadingStateChange(() => {
    setLoadingScreenBasedOnState()
  })
  observeSessionStateChange(() => {
    setLoadingScreenBasedOnState()
  })
  observeRendererStateChange(() => {
    setLoadingScreenBasedOnState()
  })
  renderStateObservable.add(() => {
    setLoadingScreenBasedOnState()
  })
  setLoadingScreenBasedOnState()

  if (!EDITOR) {
    await startGlobalScene('dcl-gs-avatars', 'Avatars', hudWorkerUrl)
  }
}

export async function startGlobalScene(cid: string, title: string, fileContentUrl: string) {
  const scene = new UnityScene({
    sceneId: cid,
    name: title,
    baseUrl: location.origin,
    main: fileContentUrl,
    useFPSThrottling: false,
    data: {},
    mappings: []
  })

  const worker = loadParcelScene(scene, undefined, true)

  await ensureUiApis(worker)

  getUnityInstance().CreateGlobalScene({
    id: getParcelSceneID(scene),
    name: scene.data.name,
    baseUrl: scene.data.baseUrl,
    isPortableExperience: false,
    contents: []
  })
}

export async function startUnitySceneWorkers() {
  await enableParcelSceneLoading({
    parcelSceneClass: UnityParcelScene,
    preloadScene: async (_land) => {
      // TODO:
      // 1) implement preload call
      // 2) await for preload message or timeout
      // 3) return
    },
    onLoadParcelScenes: (lands) => {
      getUnityInstance().LoadParcelScenes(
        lands.map(($) => {
          const x = Object.assign({}, ILandToLoadableParcelScene($).data)
          delete x.land
          return x
        })
      )
    },
    onUnloadParcelScenes: (lands) => {
      lands.forEach(($) => {
        getUnityInstance().UnloadScene($.sceneId)
      })
    },
    onPositionSettled: (spawnPoint) => {
      getUnityInstance().Teleport(spawnPoint)
      getUnityInstance().ActivateRendering()
    },
    onPositionUnsettled: () => {
      getUnityInstance().DeactivateRendering()
    }
  })
  store.dispatch(signalParcelLoadingStarted())
}

export async function getPreviewSceneId(): Promise<{ sceneId: string | null; sceneBase: string }> {
  const result = await fetch('/scene.json?nocache=' + Math.random())

  if (result.ok) {
    const scene = (await result.json()) as SceneJsonData

    const [sceneId] = await fetchSceneIds([scene.scene.base])
    return { sceneId, sceneBase: scene.scene.base }
  } else {
    throw new Error('Could not load scene.json')
  }
}

export async function loadPreviewScene(ws?: string) {
  const { sceneId, sceneBase } = await getPreviewSceneId()

  if (sceneId) {
    await reloadScene(sceneId)
  } else {
    defaultLogger.log(`Unable to load sceneId of ${sceneBase}`)
    debugger
  }
}

export function loadBuilderScene(sceneData: ILand): UnityParcelScene | undefined {
  // NOTE: check file history for previous implementation
  throw new Error('Not implemented')
}

export function unloadCurrentBuilderScene() {
  // NOTE: check file history for previous implementation
  throw new Error('Not implemented')
}

export function updateBuilderScene(sceneData: ILand) {
  // NOTE: check file history for previous implementation
  throw new Error('Not implemented')
}

teleportObservable.add((position: { x: number; y: number; text?: string }) => {
  // before setting the new position, show loading screen to avoid showing an empty world
  store.dispatch(teleportTriggered(position.text || `Teleporting to ${position.x}, ${position.y}`))
})

{
  // TODO: move to unity-renderer
  let isPointerLocked: boolean = false

  function pointerLockChange() {
    const doc: any = document
    const isLocked = (doc.pointerLockElement || doc.mozPointerLockElement || doc.webkitPointerLockElement) != null
    if (isPointerLocked !== isLocked && getUnityInstance()) {
      getUnityInstance().SetCursorState(isLocked)
    }
    isPointerLocked = isLocked
  }

  document.addEventListener('pointerlockchange', pointerLockChange, false)
}
