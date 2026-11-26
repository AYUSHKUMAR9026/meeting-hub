# Meeting Hub privacy notice template

Operator: **[organization name and contact]**. Effective date: **[date]**.

Meeting Hub processes meeting titles, times, project membership, participant names, chat messages,
temporary meeting audio, and extracted meeting content to create and review decision PDFs.

Before uploading or joining a recorded meeting, participants see the configured AI providers and
acknowledge recording and processing. Groq may receive audio for transcription and Google Gemini
may receive transcript text for analysis when those providers are selected. Explicit alternative
providers are AssemblyAI and Anthropic. Local fake providers send no data to external AI services.
Your project's Settings show the configured providers and whether external AI processing is enabled.
Providers apply their own retention policies, which Meeting Hub does not control.

Audio is temporary processing input. Meeting Hub deletes it after transcription succeeds or the
run fails permanently. Retried/deferred jobs retain input for at most 48 hours (or a shorter
configured TTL), after which another upload is required. Object-store lifecycle rules provide an
additional safety net. Audio is not offered for playback or download for new meetings.

The default saved result is a dated PDF plus extracted summary, decisions and action items,
including owner/due-date/status fields and speaker/timestamp citations. Once the PDF is verified
in storage, transcript text and provider checkpoints are deleted. A project configured to
`keep_transcript` also keeps the speaker-labelled transcript and includes it in the PDF appendix.
Chat is stored with the meeting. Earlier PDF versions remain available after edits.

Data stored before this policy is preserved until an owner explicitly purges it. Owners can preview
counts and sizes and confirm deletion of stored recordings or transcripts. Meeting deletion removes
the meeting's saved content and files. Content-free audit entries record settings changes and purges.

**[Add the operator's contact, access/deletion request process, hosting location and any applicable
organizational retention requirements before publishing this template.]**
