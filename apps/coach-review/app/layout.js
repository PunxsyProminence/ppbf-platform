import './globals.css'

export const metadata = {
  title: 'PPBF Coach Review',
  description: 'Coach review dashboard for PPBF platform',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
