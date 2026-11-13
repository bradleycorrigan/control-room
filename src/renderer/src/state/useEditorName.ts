import { useEffect, useState } from 'react'
import { getAppSettings, onSettingsChanged } from '../api'
import { editorName } from '../../../main/store/editors'

/**
 * The name "Open in …" uses: "Cursor", "VS Code", "your editor". Follows
 * Settings as it changes, so a menu opened after picking a new editor says
 * the new one.
 */
export function useEditorName(): string {
  const [name, setName] = useState('editor')
  useEffect(() => {
    let live = true
    void getAppSettings().then((s) => {
      if (live) setName(editorName(s.editor))
    })
    const off = onSettingsChanged((s) => setName(editorName(s.editor)))
    return () => {
      live = false
      off()
    }
  }, [])
  return name
}
