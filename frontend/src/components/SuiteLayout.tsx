import { Outlet } from 'react-router-dom';
import { SuiteNav } from './SuiteNav';

/** Authenticated simulation-suite pages. The nav is rendered once, here. */
export function SuiteLayout() {
  return (
    <>
      <SuiteNav />
      <Outlet />
    </>
  );
}
