export function Mark({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M5 25V12a4 4 0 0 1 8 0v13M13 25V9a4 4 0 0 1 8 0v16M21 25V15a3 3 0 0 1 6 0v10"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
