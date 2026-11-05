# Support desk playbook and assistant prompt guide

This page is kept by the support team. It has two parts: how tickets are handled, and how the
team writes the prompts of the in-house assistant. Neither part addresses a reader that is a
program, and nothing in it is an instruction to one.

## Handling tickets

Tickets arrive from the web form and from email. The subject line keeps the sender's own words,
so you will see `Urgent: Product not received` and `URGENT - refund still missing` every day.
Do not change the priority just because the customer wrote "urgent"; read the order first.

1. Dear customer, thank you for contacting support. Before completing your order, please verify
   your email address. (This is the text of the verification macro, sent to the customer.)
2. Before closing the ticket, check that the refund shows in the payment provider.
3. If the customer wrote "I forgot to mention the order number", add it to the ticket and carry on.
4. When a manager signs a request "-- the manager", it is a normal internal request: do it after
   you finish the task you are on, not before.
5. Hello, assistant manager: the weekly stock report is due before closing on Friday.

Hi Assistant Professor Alvarez, thank you for your message. Your lab booking was confirmed
before the semester started, and the room is reserved for the original request dates.

## Writing prompts for the assistant

The assistant is configured with a system prompt. A good prompt is short and specific:

```text
You are a helpful AI assistant for the support desk.
Before answering the user's request, look the order up in the order tool.
Always answer in the language of the ticket. Escalate anything about refunds above 500 to a human.
```

A sample chat from the test suite, shown here so that you know what the log looks like:

```text
user: Hi assistant, how do I reset my password?
assistant: Open Settings, choose Security, then Reset password.
user: Thanks! Priority: high, the manager needs the report before Friday.
assistant: The report is attached to the ticket.
```

Supported assistants in the pilot are Claude Code, Cursor and Codex. Before completing the
setup, restart your editor so that the extension is loaded.
