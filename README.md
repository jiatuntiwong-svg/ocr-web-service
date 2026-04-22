# OpenNext Starter

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

Read the documentation at https://opennext.js.org/cloudflare.

## Develop

Run the Next.js development server:

```bash
D:\nodejs\npm.cmd run dev
# or alternatively, add D:\nodejs\ to your System PATH environment variable
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

## Preview

Preview the application locally on the Cloudflare runtime:

```bash
D:\nodejs\npm.cmd run preview
```

## Deploy

Deploy the application to Cloudflare:

```bash
D:\nodejs\npm.cmd run deploy
```

---

## 🛠 Troubleshooting: NPM Command Not Found

If you normally encounter `The term 'npm' is not recognized` when running commands in this project, it is because **Node.js is installed on your D: drive**. 

Your active `npm` executable is located at:
👉 **`D:\nodejs\npm.cmd`**

**How to fix or bypass this:**
1. **Immediate workaround:** Use the absolute path exactly when you want to run `npm install` or other commands. For example:
   ```bash
   D:\nodejs\npm.cmd install
   ```
2. **Permanent solution:** Add `D:\nodejs` to your Windows System Environment Variables `PATH`. Once added and your terminal is restarted, you can just type `npm install` normally.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!
