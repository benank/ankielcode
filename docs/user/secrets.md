# Secrets

Credentials you enter in Settings, such as provider API keys, source control tokens, usage limit
keys, and device host tokens, are stored in the environment's secret store and never sent back to
the app. Agents can also ask you for a secret in a private card instead of in the chat.

## Secrets saved from 1Password

Earlier builds could read a credential from 1Password and save only a reference to it. Ankiel Code
no longer reads secret providers. A field that still holds a reference says so in Settings, and the
provider or feature that needs it reports that it cannot read it, without falling back to another
login. Enter the value in that field to replace the reference.

## When an agent asks for a secret

An agent that needs a token or password shows a secret request card in the thread instead of asking
you to paste it into the chat. Type or paste the value and select **Save securely**, or select
**Decline**. You can answer from desktop or mobile.

The value never appears in the conversation. Most requests keep it from the agent too: Ankiel Code
passes it to the tool that needs it. When an agent has to run a command with the value, the card
says so instead: the value goes into a private file that the agent's commands can read for about 24
hours.
