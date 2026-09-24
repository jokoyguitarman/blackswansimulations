export interface AgreementDetails {
  full_name: string;
  contact_number: string;
  address: string;
  organisation: string;
}

export const emptyAgreementDetails: AgreementDetails = {
  full_name: '',
  contact_number: '',
  address: '',
  organisation: '',
};

const DRAFT_KEY = 'prophyion_consultant_application_draft';

/** Kept on this device only until the details reach the server. */
export const saveAgreementDraft = (details: AgreementDetails) =>
  localStorage.setItem(DRAFT_KEY, JSON.stringify(details));

export const loadAgreementDraft = (): Partial<AgreementDetails> | null => {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as Partial<AgreementDetails>) : null;
  } catch {
    return null;
  }
};

export const clearAgreementDraft = () => localStorage.removeItem(DRAFT_KEY);

const labelClass = 'block text-xs font-semibold text-ink mb-2';
const inputClass = 'w-full px-4 py-3 military-input text-sm';

interface Props {
  value: AgreementDetails;
  onChange: (value: AgreementDetails) => void;
  requiresAddress: boolean;
  /** The signup form renders the name itself, next to the account fields. */
  showName?: boolean;
}

/** The details printed on the Consultant Agreement. */
export function AgreementDetailsFields({
  value,
  onChange,
  requiresAddress,
  showName = true,
}: Props) {
  const set = (field: keyof AgreementDetails) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...value, [field]: e.target.value });

  return (
    <>
      {showName && (
        <div>
          <label htmlFor="agreementFullName" className={labelClass}>
            Full legal name
          </label>
          <input
            id="agreementFullName"
            required
            minLength={2}
            maxLength={120}
            autoComplete="name"
            value={value.full_name}
            onChange={set('full_name')}
            className={inputClass}
            placeholder="Tan Mei Ling"
          />
          <p className="mt-1 text-xs text-muted">
            As on your NRIC or passport, in English letters. It is printed on your agreement.
          </p>
        </div>
      )}

      <div>
        <label htmlFor="agreementContactNumber" className={labelClass}>
          Contact number
        </label>
        <input
          id="agreementContactNumber"
          type="tel"
          required
          minLength={6}
          maxLength={30}
          autoComplete="tel"
          value={value.contact_number}
          onChange={set('contact_number')}
          className={inputClass}
          placeholder="+65 9123 4567"
        />
      </div>

      {requiresAddress && (
        <div>
          <label htmlFor="agreementAddress" className={labelClass}>
            Address
          </label>
          <input
            id="agreementAddress"
            required
            maxLength={200}
            autoComplete="street-address"
            value={value.address}
            onChange={set('address')}
            className={inputClass}
            placeholder="10 Anson Road, #20-05, Singapore 079903"
          />
        </div>
      )}

      <div>
        <label htmlFor="agreementOrganisation" className={labelClass}>
          Company or organisation <span className="font-normal text-muted">(optional)</span>
        </label>
        <input
          id="agreementOrganisation"
          maxLength={200}
          autoComplete="organization"
          value={value.organisation}
          onChange={set('organisation')}
          className={inputClass}
          placeholder="Resilience Works Pte Ltd"
        />
      </div>
    </>
  );
}
