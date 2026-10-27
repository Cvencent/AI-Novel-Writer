import { useCallback, useEffect, useRef, useState } from 'react'
import { ipc } from '../../../services/ipc-client'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { globalEventBus } from '../../../shared/event-bus'
import { sameProjectSessionContext, projectSessionContextFromProject } from '../../../shared/project-session-context'
import type { CharacterVoiceProfileRecord } from '../../../shared/writing-intelligence'

export default function CharacterVoiceCard({ characterId }: { characterId?: string }) {
  const text = useLocaleStore(s => s.text)
  // The loaded profile is paired with the character it belongs to, so switching
  // characters shows nothing until the new profile arrives (no stale flash).
  const [loaded, setLoaded] = useState<{ characterId: string; profile: CharacterVoiceProfileRecord } | null>(null)
  // Binds a read to the character it was issued for so a late reply for a
  // previously selected character can never repaint the card.
  const requestRevision = useRef(0)

  const load = useCallback(async (boundCharacterId: string | undefined, revision: number) => {
    if (!boundCharacterId) return
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session) return
    try {
      const profiles = await ipc.invokeWithProjectSession(session, 'db:writing-intelligence-voices-list', session.projectPath)
      if (isProjectSessionCurrent(session) && revision === requestRevision.current) {
        const profile = profiles.find(candidate => candidate.characterId === boundCharacterId)
        setLoaded(profile ? { characterId: boundCharacterId, profile } : null)
      }
    } catch { /* keep whatever is shown; a stale read must not blank the card */ }
  }, [])

  // A different character invalidates the old read; the paired-state guard hides
  // the previous character's card until its replacement arrives.
  useEffect(() => {
    requestRevision.current += 1
    void load(characterId, requestRevision.current)
  }, [characterId, load])

  // Extraction runs as a workflow; refresh the card once it completes for this project.
  useEffect(() => globalEventBus.on('WORKFLOW_COMPLETE', ({ projectSession }) => {
    const current = captureProjectSession(useProjectStore.getState().currentProject)
    const currentSession = projectSessionContextFromProject(useProjectStore.getState().currentProject)
    if (!current || !currentSession || !sameProjectSessionContext(projectSession, currentSession)) return
    requestRevision.current += 1
    void load(characterId, requestRevision.current)
  }), [characterId, load])

  const voice = loaded && loaded.characterId === characterId ? loaded.profile : null
  if (!voice) return null
  return (
    <section className="cast-voice-card" aria-label={text('角色声音', 'Character voice')}>
      <header><span>{text('角色声音', 'Character voice')}</span><small>{voice.characterName}</small></header>
      <p>{voice.summary}</p>
      <dl>
        <div><dt>{text('句式', 'Sentences')}</dt><dd>{voice.sentenceStyle}</dd></div>
        <div><dt>{text('用词', 'Vocabulary')}</dt><dd>{voice.vocabulary}</dd></div>
        <div><dt>{text('对白习惯', 'Dialogue habits')}</dt><dd>{voice.dialogueHabits.join('、') || '—'}</dd></div>
        <div><dt>{text('情绪表现', 'Emotional tells')}</dt><dd>{voice.emotionalTells}</dd></div>
        <div><dt>{text('避免', 'Avoid')}</dt><dd>{voice.avoid.join('、') || '—'}</dd></div>
      </dl>
    </section>
  )
}
